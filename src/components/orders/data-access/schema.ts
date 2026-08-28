import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  PAYMENT_MODES,
  SERVICE_LEVELS,
  SHIPMENT_STATUSES,
  type NormalizedOrder,
} from '../../couriers/index.js';

export const BATCH_STATUSES = ['PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS'] as const;
export const BATCH_ITEM_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'DUPLICATE'] as const;

export const shipmentStatusEnum = pgEnum('shipment_status', SHIPMENT_STATUSES);
export const paymentModeEnum = pgEnum('payment_mode', PAYMENT_MODES);
export const serviceLevelEnum = pgEnum('service_level', SERVICE_LEVELS);
export const batchStatusEnum = pgEnum('batch_status', BATCH_STATUSES);
export const batchItemStatusEnum = pgEnum('batch_item_status', BATCH_ITEM_STATUSES);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: text('order_id').notNull().unique(),
    courierPartner: text('courier_partner').notNull(),
    courierOrderId: text('courier_order_id'),
    awb: text('awb'),
    status: shipmentStatusEnum('status').notNull(),
    paymentMode: paymentModeEnum('payment_mode').notNull(),
    serviceLevel: serviceLevelEnum('service_level').notNull(),
    collectableAmount: numeric('collectable_amount', { precision: 12, scale: 2 }).notNull(),
    declaredValue: numeric('declared_value', { precision: 12, scale: 2 }).notNull(),
    labelUrl: text('label_url'),
    normalizedPayload: jsonb('normalized_payload').$type<NormalizedOrder>().notNull(),
    requestPayload: jsonb('request_payload'),
    responsePayload: jsonb('response_payload'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    lastTrackedAt: timestamp('last_tracked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_status_idx').on(table.status),
    index('orders_courier_partner_idx').on(table.courierPartner),
    index('orders_awb_idx').on(table.awb),
  ],
);

export const trackingEvents = pgTable(
  'tracking_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    status: shipmentStatusEnum('status').notNull(),
    courierStatusCode: text('courier_status_code').notNull(),
    courierStatusDescription: text('courier_status_description'),
    reasonCode: text('reason_code'),
    reasonDescription: text('reason_description'),
    location: text('location'),
    eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
    rawPayload: jsonb('raw_payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tracking_events_order_idx').on(table.orderId),
    // The courier returns its full scan list on every poll. This is what makes re-reading it
    // append-only instead of duplicating history.
    unique('tracking_events_unique_scan').on(table.orderId, table.courierStatusCode, table.eventTime),
  ],
);

export const bulkBatches = pgTable('bulk_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: batchStatusEnum('status').notNull().default('PROCESSING'),
  totalCount: integer('total_count').notNull(),
  acceptedCount: integer('accepted_count').notNull(),
  rejectedCount: integer('rejected_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const bulkBatchItems = pgTable(
  'bulk_batch_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => bulkBatches.id, { onDelete: 'cascade' }),
    orderId: text('order_id').notNull(),
    courierPartner: text('courier_partner').notNull(),
    status: batchItemStatusEnum('status').notNull().default('PENDING'),
    awb: text('awb'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('bulk_batch_items_batch_idx').on(table.batchId),
    unique('bulk_batch_items_unique_order').on(table.batchId, table.orderId),
  ],
);

export type OrderRow = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type TrackingEventRow = typeof trackingEvents.$inferSelect;
export type NewTrackingEvent = typeof trackingEvents.$inferInsert;
export type BulkBatchRow = typeof bulkBatches.$inferSelect;
export type BulkBatchItemRow = typeof bulkBatchItems.$inferSelect;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];
