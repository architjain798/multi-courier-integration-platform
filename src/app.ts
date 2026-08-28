import express, { type Express } from 'express';
import { createCouriersRouter } from './components/couriers/index.js';
import { createApiRouter } from './components/orders/index.js';
import type { Container } from './container.js';
import { createHealthRouter } from './libraries/http/health.routes.js';
import { accessLog } from './libraries/http/middleware/access-log.js';
import { apiKeyGuard } from './libraries/http/middleware/api-key.js';
import { bodyErrors } from './libraries/http/middleware/body-errors.js';
import { errorMiddleware, notFound } from './libraries/http/middleware/error.middleware.js';
import { requestId } from './libraries/http/middleware/request-id.js';
import { createDocsRouter } from './libraries/openapi/swagger.js';
import { buildOpenApiDocument } from './openapi.js';

const VERSION = '1.0.0';

export type AppDependencies = Pick<
  Container,
  'config' | 'logger' | 'errorHandler' | 'controller' | 'couriersController' | 'healthChecks'
>;

export function createApp(container: AppDependencies): Express {
  const app = express();
  const bodyLimit = container.config.requestBodyLimit;

  app.disable('x-powered-by');

  // Before the body parser, so a request that fails to parse still gets an id: those are exactly
  // the responses somebody will bring to us asking what happened.
  app.use(requestId());
  app.use(accessLog(container.logger));

  app.use(createHealthRouter(container.healthChecks, VERSION));
  app.use(createDocsRouter(buildOpenApiDocument(VERSION)));

  app.use(express.json({ limit: bodyLimit }));
  app.use(bodyErrors(bodyLimit));

  app.use(apiKeyGuard(container.config.apiKey));
  app.use('/api/v1', createCouriersRouter(container.couriersController));
  app.use('/api/v1', createApiRouter(container.controller));

  app.use(notFound());
  app.use(errorMiddleware(container.errorHandler, container.config.debugCourierErrors));

  return app;
}
