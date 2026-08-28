import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { AppError, ErrorCode } from '../../../libraries/errors/index.js';
import type { NormalizedOrder, ShipmentStatus } from '../../couriers/index.js';
import { orders, type OrderRow } from './schema.js';

export type PendingOrderInput = {
  orderId: string;
  courierPartner: string;
  paymentMode: NormalizedOrder['paymentMode'];
  serviceLevel: NormalizedOrder['serviceLevel'];
  collectableAmount: number;
  declaredValue: number;
  normalizedPayload: NormalizedOrder;
  metadata: Record<string, unknown> | null;
};

export type ShipmentPersisted = {
  awb: string;
  courierOrderId: string | null;
  labelUrl: string | null;
  status: ShipmentStatus;
  requestPayload: unknown;
  responsePayload: unknown;
};

export type FailurePersisted = {
  status: ShipmentStatus;
  failureCode: string;
  failureMessage: string;
  requestPayload: unknown;
  responsePayload: unknown;
};

export type OrderListFilter = {
  statuses?: ShipmentStatus[];
  courierPartner?: string;
  limit: number;
  offset: number;
};

export class OrderRepository {
  constructor(private readonly db: Database) {}

  async insertPending(
    input: PendingOrderInput,
  ): Promise<{ order: OrderRow; alreadyExisted: boolean }> {
    const inserted = await this.db
      .insert(orders)
      .values({
        orderId: input.orderId,
        courierPartner: input.courierPartner,
        status: 'PENDING',
        paymentMode: input.paymentMode,
        serviceLevel: input.serviceLevel,
        collectableAmount: input.collectableAmount.toFixed(2),
        declaredValue: input.declaredValue.toFixed(2),
        normalizedPayload: input.normalizedPayload,
        metadata: input.metadata,
      })
      .onConflictDoNothing({ target: orders.orderId })
      .returning();

    const created = inserted[0];
    if (created !== undefined) {
      return { order: created, alreadyExisted: false };
    }

    const existing = await this.findByOrderId(input.orderId);
    if (existing === undefined) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Order "${input.orderId}" conflicted on insert but could not be read back`,
        { isOperational: false },
      );
    }
    return { order: existing, alreadyExisted: true };
  }

  async findByOrderId(orderId: string): Promise<OrderRow | undefined> {
    const rows = await this.db.select().from(orders).where(eq(orders.orderId, orderId)).limit(1);
    return rows[0];
  }

  async requireByOrderId(orderId: string): Promise<OrderRow> {
    const order = await this.findByOrderId(orderId);
    if (order === undefined) {
      throw new AppError(ErrorCode.ORDER_NOT_FOUND, `No order with id "${orderId}"`);
    }
    return order;
  }

  async markShipmentCreated(rowId: string, shipment: ShipmentPersisted): Promise<OrderRow> {
    return this.updateOne(rowId, {
      awb: shipment.awb,
      courierOrderId: shipment.courierOrderId,
      labelUrl: shipment.labelUrl,
      status: shipment.status,
      requestPayload: shipment.requestPayload,
      responsePayload: shipment.responsePayload,
      failureCode: null,
      failureMessage: null,
    });
  }

  async markFailed(rowId: string, failure: FailurePersisted): Promise<OrderRow> {
    return this.updateOne(rowId, {
      status: failure.status,
      failureCode: failure.failureCode,
      failureMessage: failure.failureMessage,
      requestPayload: failure.requestPayload,
      responsePayload: failure.responsePayload,
    });
  }

  async markTracked(rowId: string, status: ShipmentStatus, trackedAt: Date): Promise<OrderRow> {
    return this.updateOne(rowId, { status, lastTrackedAt: trackedAt });
  }

  async updateStatus(rowId: string, status: ShipmentStatus): Promise<OrderRow> {
    return this.updateOne(rowId, { status });
  }

  list(filter: OrderListFilter): Promise<OrderRow[]> {
    const conditions: SQL[] = [];
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      conditions.push(inArray(orders.status, filter.statuses));
    }
    if (filter.courierPartner !== undefined) {
      conditions.push(eq(orders.courierPartner, filter.courierPartner));
    }

    const query = this.db.select().from(orders);
    const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;

    return filtered.orderBy(desc(orders.createdAt)).limit(filter.limit).offset(filter.offset);
  }

  private async updateOne(
    rowId: string,
    values: Partial<typeof orders.$inferInsert>,
  ): Promise<OrderRow> {
    const updated = await this.db
      .update(orders)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(orders.id, rowId))
      .returning();

    const row = updated[0];
    if (row === undefined) {
      throw new AppError(ErrorCode.ORDER_NOT_FOUND, `No order row with id "${rowId}"`);
    }
    return row;
  }
}
