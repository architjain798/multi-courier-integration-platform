import { clientMessageFor } from '../../../libraries/errors/index.js';
import type { OrderRow, TrackingEventRow } from '../data-access/schema.js';

export function presentOrder(order: OrderRow, idempotentReplay = false): Record<string, unknown> {
  return {
    order_id: order.orderId,
    courier_partner: order.courierPartner,
    courier_order_id: order.courierOrderId,
    awb: order.awb,
    status: order.status,
    payment_mode: order.paymentMode,
    service_level: order.serviceLevel,
    collectable_amount: Number(order.collectableAmount),
    declared_value: Number(order.declaredValue),
    label_url: order.labelUrl,
    failure: presentFailure(order.failureCode, order.failureMessage),
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
    last_tracked_at: order.lastTrackedAt?.toISOString() ?? null,
    ...(idempotentReplay ? { idempotent_replay: true } : {}),
  };
}

// A failure raised by an adapter is stored with the courier's own wording, which requirement 3.5
// forbids returning. Every code an adapter can raise has an entry in clientMessages, so a hit there
// means "replace this text"; a miss means the message was ours to begin with and can go out as is.
export function presentFailure(
  code: string | null,
  storedMessage: string | null,
): { code: string; message: string } | null {
  if (code === null) {
    return null;
  }
  return {
    code,
    message: clientMessageFor(code) ?? storedMessage ?? 'The order could not be completed',
  };
}

export function presentTrackingEvent(event: TrackingEventRow): Record<string, unknown> {
  return {
    status: event.status,
    courier_status_code: event.courierStatusCode,
    courier_status_description: event.courierStatusDescription,
    reason_code: event.reasonCode,
    reason_description: event.reasonDescription,
    location: event.location,
    event_time: event.eventTime.toISOString(),
    recorded_at: event.createdAt.toISOString(),
  };
}
