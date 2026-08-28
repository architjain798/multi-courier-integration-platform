import type { Queue } from 'bullmq';
import {
  auditOf,
  courierMessageOf,
  ShipmentStatus,
  type BatchCreateOutcome,
  type CourierAdapter,
  type CourierRegistry,
  type CourierResult,
  type NormalizedOrder,
} from '../../couriers/index.js';
import {
  AppError,
  detailsFromZodError,
  ErrorCode,
  isAppError,
  type ErrorDetail,
} from '../../../libraries/errors/index.js';
import type { Logger } from '../../../libraries/logger/index.js';
import type { BatchItemSeed, BulkBatchRepository } from '../data-access/bulk-batch.repository.js';
import type { OrderRepository } from '../data-access/order.repository.js';
import type { BulkBatchItemRow, BulkBatchRow, OrderRow } from '../data-access/schema.js';
import {
  createOrderSchema,
  toNormalizedOrder,
} from '../entry-points/api/orders.schemas.js';
import type { OrderService } from './order.service.js';

export type BulkChunkJob = {
  batchId: string;
  courierPartner: string;
  orderIds: string[];
};

export type RejectedOrder = {
  index: number;
  order_id: string | null;
  code: string;
  message: string;
  details: ErrorDetail[];
};

export type BulkSubmission = {
  batch: BulkBatchRow;
  acceptedCount: number;
  rejected: RejectedOrder[];
};

export class BulkOrderService {
  constructor(
    private readonly orderService: OrderService,
    private readonly orders: OrderRepository,
    private readonly batches: BulkBatchRepository,
    private readonly registry: CourierRegistry,
    private readonly queue: Queue<BulkChunkJob>,
    private readonly maxOrders: number,
    private readonly jobAttempts: number,
    private readonly backoffMs: number,
    private readonly logger: Logger,
  ) {}

  async submit(rawOrders: readonly unknown[]): Promise<BulkSubmission> {
    if (rawOrders.length > this.maxOrders) {
      throw AppError.validation(
        `A bulk request may contain at most ${this.maxOrders} orders`,
        [{ field: 'orders', issue: 'too_many', received: rawOrders.length }],
      );
    }

    const rejected: RejectedOrder[] = [];
    const accepted: NormalizedOrder[] = [];
    const seen = new Set<string>();

    for (const [index, raw] of rawOrders.entries()) {
      const parsed = createOrderSchema.safeParse(raw);
      if (!parsed.success) {
        rejected.push(
          reject(
            index,
            orderIdOf(raw),
            AppError.validation('Order failed validation', detailsFromZodError(parsed.error)),
          ),
        );
        continue;
      }

      const order = toNormalizedOrder(parsed.data);

      if (seen.has(order.orderId)) {
        rejected.push(
          reject(
            index,
            order.orderId,
            new AppError(
              ErrorCode.DUPLICATE_IN_REQUEST,
              `order_id "${order.orderId}" appears more than once in this request`,
            ),
          ),
        );
        continue;
      }
      if (!this.registry.has(order.courierPartner)) {
        rejected.push(
          reject(
            index,
            order.orderId,
            new AppError(
              ErrorCode.UNKNOWN_COURIER_PARTNER,
              `Unsupported courier_partner "${order.courierPartner}"`,
              { details: [{ supported: this.registry.ids() }] },
            ),
          ),
        );
        continue;
      }

      seen.add(order.orderId);
      accepted.push(order);
    }

    const seeds: BatchItemSeed[] = [];
    const queued: NormalizedOrder[] = [];

    for (const order of accepted) {
      const { order: row, alreadyExisted } = await this.orderService.reserve(order);
      if (alreadyExisted && row.status !== ShipmentStatus.PENDING) {
        seeds.push({
          orderId: order.orderId,
          courierPartner: order.courierPartner,
          status: 'DUPLICATE',
          ...(row.awb === null ? {} : { awb: row.awb }),
        });
        continue;
      }
      seeds.push({ orderId: order.orderId, courierPartner: order.courierPartner, status: 'PENDING' });
      queued.push(order);
    }

    const batch = await this.batches.create({
      totalCount: rawOrders.length,
      acceptedCount: queued.length,
      rejectedCount: rejected.length + (seeds.length - queued.length),
      items: seeds,
    });

    await this.enqueue(batch.id, queued);

    return { batch, acceptedCount: queued.length, rejected };
  }

  async status(batchId: string): Promise<{ batch: BulkBatchRow; items: BulkBatchItemRow[] }> {
    return this.batches.findById(batchId);
  }

  async processChunk(job: BulkChunkJob): Promise<void> {
    const adapter = this.registry.get(job.courierPartner);
    const rows: OrderRow[] = [];

    for (const orderId of job.orderIds) {
      const row = await this.orders.requireByOrderId(orderId);
      if (row.status === ShipmentStatus.PENDING) {
        rows.push(row);
      }
    }

    if (rows.length === 0) {
      await this.batches.refreshStatus(job.batchId);
      return;
    }

    const batchCreate = adapter.createShipments?.bind(adapter);
    if (adapter.capabilities.supportsBatchCreate && batchCreate !== undefined && rows.length > 1) {
      await this.runNativeBatch(job.batchId, adapter, rows, batchCreate);
    } else {
      await this.runOneByOne(job.batchId, adapter, rows);
    }

    await this.batches.refreshStatus(job.batchId);
  }

  private async runNativeBatch(
    batchId: string,
    adapter: CourierAdapter,
    rows: OrderRow[],
    batchCreate: (orders: NormalizedOrder[]) => Promise<CourierResult<BatchCreateOutcome[]>>,
  ): Promise<void> {
    const rowsByOrderId = new Map(rows.map((row) => [row.orderId, row]));
    const result = await batchCreate(rows.map((row) => row.normalizedPayload));
    const call = result.audit.find((entry) => entry.operation === 'CREATE_SHIPMENT');

    for (const outcome of result.value) {
      const row = rowsByOrderId.get(outcome.orderId);
      if (row === undefined) {
        this.logger.warn(
          { batchId, orderId: outcome.orderId, courierPartner: adapter.id },
          'Courier returned an outcome for an order that was not in this chunk',
        );
        continue;
      }
      rowsByOrderId.delete(outcome.orderId);

      if (outcome.ok) {
        await this.orders.markShipmentCreated(row.id, {
          awb: outcome.shipment.awb,
          courierOrderId: outcome.shipment.courierOrderId ?? null,
          labelUrl: outcome.shipment.labelUrl ?? null,
          status: outcome.shipment.status,
          requestPayload: call?.requestBody ?? null,
          responsePayload: call?.responseBody ?? null,
        });
        await this.batches.recordOutcome(batchId, row.orderId, {
          status: 'SUCCEEDED',
          awb: outcome.shipment.awb,
        });
      } else {
        await this.recordFailure(batchId, row, outcome.error);
      }
    }

    for (const orphan of rowsByOrderId.values()) {
      const error = new AppError(
        ErrorCode.COURIER_VALIDATION_ERROR,
        'Courier returned no outcome for this order',
      );
      await this.recordFailure(batchId, orphan, error);
    }
  }

  private async runOneByOne(
    batchId: string,
    adapter: CourierAdapter,
    rows: OrderRow[],
  ): Promise<void> {
    for (const row of rows) {
      try {
        const updated = await this.orderService.dispatch(row, adapter);
        await this.batches.recordOutcome(batchId, row.orderId, {
          status: 'SUCCEEDED',
          ...(updated.awb === null ? {} : { awb: updated.awb }),
        });
      } catch (error) {
        if (!isAppError(error) || error.retryable) {
          throw error;
        }
        await this.batches.recordOutcome(batchId, row.orderId, {
          status: 'FAILED',
          errorCode: error.code,
          errorMessage: error.message,
        });
      }
    }
  }

  private async recordFailure(batchId: string, row: OrderRow, error: AppError): Promise<void> {
    const duplicate = error.code === ErrorCode.DUPLICATE_AT_COURIER;
    await this.orders.markFailed(row.id, {
      status: duplicate ? ShipmentStatus.RECONCILIATION_REQUIRED : ShipmentStatus.FAILED,
      failureCode: error.code,
      failureMessage: courierMessageOf(error) ?? error.message,
      requestPayload: auditOf(error).at(-1)?.requestBody ?? null,
      responsePayload: auditOf(error).at(-1)?.responseBody ?? null,
    });
    await this.batches.recordOutcome(batchId, row.orderId, {
      status: 'FAILED',
      errorCode: error.code,
      errorMessage: error.message,
    });
  }

  private async enqueue(batchId: string, orders: readonly NormalizedOrder[]): Promise<void> {
    const byCourier = new Map<string, string[]>();
    for (const order of orders) {
      const existing = byCourier.get(order.courierPartner) ?? [];
      existing.push(order.orderId);
      byCourier.set(order.courierPartner, existing);
    }

    for (const [courierPartner, orderIds] of byCourier) {
      const size = Math.max(1, this.registry.get(courierPartner).capabilities.maxBatchSize);
      for (let start = 0; start < orderIds.length; start += size) {
        await this.queue.add(
          'chunk',
          { batchId, courierPartner, orderIds: orderIds.slice(start, start + size) },
          {
            attempts: this.jobAttempts,
            backoff: { type: 'exponential', delay: this.backoffMs },
            removeOnComplete: 500,
            removeOnFail: 500,
          },
        );
      }
    }
  }
}

function reject(index: number, orderId: string | null, error: AppError): RejectedOrder {
  return {
    index,
    order_id: orderId,
    code: error.code,
    message: error.message,
    details: error.details,
  };
}

function orderIdOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || !('order_id' in raw)) {
    return null;
  }
  const value: unknown = raw.order_id;
  return typeof value === 'string' ? value : null;
}
