import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { COURIER_OPERATIONS } from '../domain/courier.types.js';

export const courierOperationEnum = pgEnum('courier_operation', COURIER_OPERATIONS);

export const courierApiLogs = pgTable(
  'courier_api_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courierPartner: text('courier_partner').notNull(),
    operation: courierOperationEnum('operation').notNull(),
    reference: text('reference'),
    requestId: text('request_id'),
    url: text('url').notNull(),
    requestBody: jsonb('request_body'),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body'),
    durationMs: integer('duration_ms').notNull(),
    attempt: integer('attempt').notNull().default(1),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('courier_api_logs_reference_idx').on(table.reference),
    index('courier_api_logs_request_id_idx').on(table.requestId),
    index('courier_api_logs_created_at_idx').on(table.createdAt),
  ],
);

export type CourierApiLogRow = typeof courierApiLogs.$inferSelect;
export type NewCourierApiLog = typeof courierApiLogs.$inferInsert;
