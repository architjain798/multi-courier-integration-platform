import { Router } from 'express';
import type { OrdersController } from './orders.controller.js';

export function createApiRouter(controller: OrdersController): Router {
  const router = Router();

  router.post('/orders/bulk', controller.bulkCreate);
  router.post('/orders', controller.create);
  router.get('/orders', controller.list);
  router.get('/orders/:orderId', controller.get);
  router.get('/orders/:orderId/track', controller.track);
  router.post('/orders/:orderId/cancel', controller.cancel);
  router.post('/orders/:orderId/retry', controller.retry);

  router.get('/batches/:batchId', controller.batchStatus);

  return router;
}
