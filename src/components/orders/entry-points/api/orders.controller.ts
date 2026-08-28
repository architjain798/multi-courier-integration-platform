import type { RequestHandler } from 'express';
import { success } from '../../../../libraries/http/envelope.js';
import { parseBody, parseQuery } from '../../../../libraries/http/validate.js';
import type { BulkOrderService } from '../../domain/bulk-order.service.js';
import {
  presentFailure,
  presentOrder,
  presentTrackingEvent,
} from '../../domain/order.presenter.js';
import type { OrderService } from '../../domain/order.service.js';
import type { TrackingService } from '../../domain/tracking.service.js';
import {
  bulkCreateOrdersSchema,
  createOrderSchema,
  listOrdersQuerySchema,
  toNormalizedOrder,
} from './orders.schemas.js';

export type OrdersControllerDependencies = {
  orderService: OrderService;
  trackingService: TrackingService;
  bulkService: BulkOrderService;
};

export type OrdersController = {
  create: RequestHandler;
  bulkCreate: RequestHandler;
  list: RequestHandler;
  get: RequestHandler<{ orderId: string }>;
  track: RequestHandler<{ orderId: string }>;
  cancel: RequestHandler<{ orderId: string }>;
  retry: RequestHandler<{ orderId: string }>;
  batchStatus: RequestHandler<{ batchId: string }>;
};

export function createOrdersController(deps: OrdersControllerDependencies): OrdersController {
  return {
    async create(req, res) {
      const input = toNormalizedOrder(parseBody(createOrderSchema, req.body));
      const { order, idempotentReplay } = await deps.orderService.create(input);

      res.status(idempotentReplay ? 200 : 201).json(success(presentOrder(order, idempotentReplay)));
    },

    async bulkCreate(req, res) {
      const { orders } = parseBody(bulkCreateOrdersSchema, req.body);
      const submission = await deps.bulkService.submit(orders);

      res.status(202).json(
        success({
          batch_id: submission.batch.id,
          status: submission.batch.status,
          total_count: submission.batch.totalCount,
          accepted_count: submission.batch.acceptedCount,
          rejected_count: submission.batch.rejectedCount,
          rejected: submission.rejected,
          status_url: `/api/v1/batches/${submission.batch.id}`,
        }),
      );
    },

    async list(req, res) {
      const query = parseQuery(listOrdersQuerySchema, req.query);
      const statuses =
        query.status === undefined
          ? undefined
          : Array.isArray(query.status)
            ? query.status
            : [query.status];

      const orders = await deps.orderService.list({
        limit: query.limit,
        offset: query.offset,
        ...(statuses === undefined ? {} : { statuses }),
        ...(query.courier_partner === undefined ? {} : { courierPartner: query.courier_partner }),
      });

      res.json(
        success({
          orders: orders.map((order) => presentOrder(order)),
          limit: query.limit,
          offset: query.offset,
        }),
      );
    },

    async get(req, res) {
      const order = await deps.orderService.get(req.params.orderId);
      res.json(success(presentOrder(order)));
    },

    async track(req, res) {
      const result = await deps.trackingService.track(req.params.orderId);

      res.json(
        success({
          ...presentOrder(result.order),
          refreshed_from_courier: result.refreshed,
          history: result.events.map(presentTrackingEvent),
        }),
      );
    },

    async cancel(req, res) {
      const order = await deps.orderService.cancel(req.params.orderId);
      res.json(success(presentOrder(order)));
    },

    async retry(req, res) {
      const { order, idempotentReplay } = await deps.orderService.retry(req.params.orderId);
      res.json(success(presentOrder(order, idempotentReplay)));
    },

    async batchStatus(req, res) {
      const { batch, items } = await deps.bulkService.status(req.params.batchId);

      res.json(
        success({
          batch_id: batch.id,
          status: batch.status,
          total_count: batch.totalCount,
          accepted_count: batch.acceptedCount,
          rejected_count: batch.rejectedCount,
          created_at: batch.createdAt.toISOString(),
          completed_at: batch.completedAt?.toISOString() ?? null,
          items: items.map((item) => ({
            order_id: item.orderId,
            courier_partner: item.courierPartner,
            status: item.status,
            awb: item.awb,
            error: presentFailure(item.errorCode, item.errorMessage),
          })),
        }),
      );
    },
  };
}
