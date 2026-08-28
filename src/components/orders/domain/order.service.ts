import {
  auditOf,
  courierMessageOf,
  isCancellable,
  ShipmentStatus,
  type CourierAdapter,
  type CourierAudit,
  type CourierRegistry,
  type NormalizedOrder,
} from '../../couriers/index.js';
import { AppError, ErrorCode, isAppError } from '../../../libraries/errors/index.js';
import type { Logger } from '../../../libraries/logger/index.js';
import type { OrderListFilter, OrderRepository } from '../data-access/order.repository.js';
import type { TrackingEventRepository } from '../data-access/tracking-event.repository.js';
import type { OrderRow } from '../data-access/schema.js';

export type CreateOrderResult = {
  order: OrderRow;
  idempotentReplay: boolean;
};

export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly trackingEvents: TrackingEventRepository,
    private readonly registry: CourierRegistry,
    private readonly logger: Logger,
  ) {}

  async create(input: NormalizedOrder): Promise<CreateOrderResult> {
    const adapter = this.registry.get(input.courierPartner);
    const { order, alreadyExisted } = await this.reserve(input);

    // A PENDING row that already existed means an earlier attempt died before the courier
    // answered. Re-driving it is safe; anything further along is a genuine replay.
    if (alreadyExisted && order.status !== ShipmentStatus.PENDING) {
      return { order, idempotentReplay: true };
    }

    return { order: await this.dispatch(order, adapter), idempotentReplay: false };
  }

  async reserve(input: NormalizedOrder): Promise<{ order: OrderRow; alreadyExisted: boolean }> {
    return this.orders.insertPending({
      orderId: input.orderId,
      courierPartner: input.courierPartner,
      paymentMode: input.paymentMode,
      serviceLevel: input.serviceLevel,
      collectableAmount: input.collectableAmount,
      declaredValue: input.declaredValue,
      normalizedPayload: input,
      metadata: input.metadata ?? null,
    });
  }

  async dispatch(order: OrderRow, adapter: CourierAdapter): Promise<OrderRow> {
    try {
      const result = await adapter.createShipment(order.normalizedPayload);
      const call = creationCall(result.audit);

      return await this.orders.markShipmentCreated(order.id, {
        awb: result.value.awb,
        courierOrderId: result.value.courierOrderId ?? null,
        labelUrl: result.value.labelUrl ?? null,
        status: result.value.status,
        requestPayload: call?.requestBody ?? null,
        responsePayload: call?.responseBody ?? null,
      });
    } catch (error) {
      if (!isAppError(error)) {
        throw error;
      }

      const duplicate = error.code === ErrorCode.DUPLICATE_AT_COURIER;
      const call = creationCall(auditOf(error));

      await this.orders.markFailed(order.id, {
        status: duplicate ? ShipmentStatus.RECONCILIATION_REQUIRED : ShipmentStatus.FAILED,
        failureCode: error.code,
        failureMessage: courierMessageOf(error) ?? error.message,
        requestPayload: call?.requestBody ?? null,
        responsePayload: call?.responseBody ?? null,
      });

      if (duplicate) {
        // The courier already has this shipment but its duplicate response carries no AWB, and it
        // exposes no lookup-by-order-number endpoint. Nothing automated can close this gap.
        this.logger.error(
          { orderId: order.orderId, courierPartner: order.courierPartner },
          'Courier reports the order as already shipped without returning an AWB; manual reconciliation required',
        );
      }

      throw error;
    }
  }

  async retry(orderId: string): Promise<CreateOrderResult> {
    const order = await this.orders.requireByOrderId(orderId);

    if (order.awb !== null) {
      return { order, idempotentReplay: true };
    }
    if (order.status === ShipmentStatus.RECONCILIATION_REQUIRED) {
      throw new AppError(
        ErrorCode.RECONCILIATION_REQUIRED,
        `Order "${orderId}" already exists at the courier without a known AWB and cannot be retried automatically`,
      );
    }

    const adapter = this.registry.get(order.courierPartner);
    return { order: await this.dispatch(order, adapter), idempotentReplay: false };
  }

  async cancel(orderId: string): Promise<OrderRow> {
    const order = await this.orders.requireByOrderId(orderId);

    if (order.awb === null) {
      throw new AppError(
        ErrorCode.SHIPMENT_NOT_CANCELLABLE,
        `Order "${orderId}" has no AWB and was never handed to a courier`,
      );
    }
    if (!isCancellable(order.status)) {
      throw new AppError(
        ErrorCode.SHIPMENT_NOT_CANCELLABLE,
        `Order "${orderId}" is ${order.status} and can no longer be cancelled`,
      );
    }

    const adapter = this.registry.get(order.courierPartner);
    if (!adapter.capabilities.supportsCancel) {
      throw new AppError(
        ErrorCode.OPERATION_NOT_SUPPORTED,
        `Courier "${order.courierPartner}" does not support cancellation`,
      );
    }

    await adapter.cancelShipment(order.awb);
    return this.orders.updateStatus(order.id, ShipmentStatus.CANCELLED);
  }

  get(orderId: string): Promise<OrderRow> {
    return this.orders.requireByOrderId(orderId);
  }

  list(filter: OrderListFilter): Promise<OrderRow[]> {
    return this.orders.list(filter);
  }

  trackingHistory(orderRowId: string) {
    return this.trackingEvents.listByOrder(orderRowId);
  }
}

function creationCall(audit: readonly CourierAudit[]): CourierAudit | undefined {
  return audit.find((entry) => entry.operation === 'CREATE_SHIPMENT');
}
