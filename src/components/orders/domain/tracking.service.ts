import type { CourierRegistry } from '../../couriers/index.js';
import { AppError, ErrorCode } from '../../../libraries/errors/index.js';
import type { Logger } from '../../../libraries/logger/index.js';
import type { OrderRepository } from '../data-access/order.repository.js';
import type { OrderRow, TrackingEventRow } from '../data-access/schema.js';
import type { TrackingEventRepository } from '../data-access/tracking-event.repository.js';

export type TrackingResult = {
  order: OrderRow;
  events: TrackingEventRow[];
  refreshed: boolean;
};

export class TrackingService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly trackingEvents: TrackingEventRepository,
    private readonly registry: CourierRegistry,
    private readonly ttlSeconds: number,
    private readonly logger: Logger,
  ) {}

  async track(orderId: string): Promise<TrackingResult> {
    const order = await this.orders.requireByOrderId(orderId);

    if (order.awb === null) {
      throw new AppError(
        ErrorCode.SHIPMENT_NOT_TRACKABLE,
        `Order "${orderId}" has no AWB yet and cannot be tracked`,
      );
    }

    if (this.isFresh(order)) {
      return {
        order,
        events: await this.trackingEvents.listByOrder(order.id),
        refreshed: false,
      };
    }

    const adapter = this.registry.get(order.courierPartner);
    const result = await adapter.trackShipment(order.awb);

    const appended = await this.trackingEvents.appendNew(order.id, result.value.scans);
    const updated = await this.orders.markTracked(order.id, result.value.status, new Date());

    this.logger.debug(
      { orderId, courierPartner: order.courierPartner, appended, status: result.value.status },
      'Refreshed tracking from courier',
    );

    return {
      order: updated,
      events: await this.trackingEvents.listByOrder(order.id),
      refreshed: true,
    };
  }

  private isFresh(order: OrderRow): boolean {
    if (this.ttlSeconds === 0 || order.lastTrackedAt === null) {
      return false;
    }
    return Date.now() - order.lastTrackedAt.getTime() < this.ttlSeconds * 1000;
  }
}
