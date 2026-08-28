import { Router } from 'express';
import type { CouriersController } from './couriers.controller.js';

export function createCouriersRouter(controller: CouriersController): Router {
  const router = Router();

  router.get('/couriers', controller.list);
  router.get('/serviceability', controller.serviceability);

  return router;
}
