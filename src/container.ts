import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { CourierApiLogRepository } from './components/couriers/data-access/courier-api-log.repository.js';
import { AuditLoggingCourierAdapter } from './components/couriers/domain/decorators/audit-log.decorator.js';
import { AuthRefreshingCourierAdapter } from './components/couriers/domain/decorators/auth-refresh.decorator.js';
import {
  RetryingCourierAdapter,
  type RetryOptions,
} from './components/couriers/domain/decorators/retry.decorator.js';
import {
  buildRegistry,
  createCouriersController,
  type CourierRegistry,
  type CouriersController,
} from './components/couriers/index.js';
import {
  BulkBatchRepository,
  BulkOrderService,
  createOrdersController,
  OrderRepository,
  OrderService,
  TrackingEventRepository,
  TrackingService,
  type BulkChunkJob,
  type OrdersController,
} from './components/orders/index.js';
import { createDatabase, type Database } from './db/client.js';
import { COURIER_DESCRIPTORS } from './integrations/index.js';
import type { AppConfig } from './libraries/config/index.js';
import { ErrorHandler } from './libraries/errors/index.js';
import type { DependencyCheck } from './libraries/http/health.routes.js';
import { createLogger, type Logger } from './libraries/logger/index.js';
import {
  BULK_CREATE_QUEUE,
  createQueue,
  createQueueConnection,
  type QueueHandle,
} from './libraries/queue/index.js';

export type Container = {
  config: AppConfig;
  logger: Logger;
  errorHandler: ErrorHandler;
  db: Database;
  registry: CourierRegistry;
  orderService: OrderService;
  trackingService: TrackingService;
  bulkService: BulkOrderService;
  controller: OrdersController;
  couriersController: CouriersController;
  bulkQueue: Queue<BulkChunkJob>;
  queueHandle: QueueHandle;
  healthChecks: DependencyCheck[];
  shutdown: () => Promise<void>;
};

export function createContainer(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): Container {
  const logger = createLogger({ level: config.logLevel, pretty: config.logPretty });
  const errorHandler = new ErrorHandler(logger);

  const { db, pool } = createDatabase(config.databaseUrl, logger);
  const orders = new OrderRepository(db);
  const trackingEvents = new TrackingEventRepository(db);
  const batches = new BulkBatchRepository(db);
  const courierLogs = new CourierApiLogRepository(db);

  const registry = buildRegistry(COURIER_DESCRIPTORS, env, { logger }, (adapter) => {
    const audited = new AuditLoggingCourierAdapter(adapter, courierLogs, logger);
    const reauthenticating = new AuthRefreshingCourierAdapter(audited, logger);
    return new RetryingCourierAdapter(reauthenticating, retryOptionsFor(adapter.id, env), logger);
  });

  const queueHandle = createQueueConnection(config.redisUrl, logger);
  const bulkQueue = createQueue<BulkChunkJob>(BULK_CREATE_QUEUE, queueHandle);

  const orderService = new OrderService(orders, trackingEvents, registry, logger);
  const trackingService = new TrackingService(
    orders,
    trackingEvents,
    registry,
    config.trackingTtlSeconds,
    logger,
  );
  const bulkService = new BulkOrderService(
    orderService,
    orders,
    batches,
    registry,
    bulkQueue,
    config.bulk.maxOrders,
    config.bulk.jobAttempts,
    config.bulk.backoffMs,
    logger,
  );

  const controller = createOrdersController({ orderService, trackingService, bulkService });
  const couriersController = createCouriersController(registry);

  const healthChecks: DependencyCheck[] = [
    {
      name: 'postgres',
      probe: async () => {
        await db.execute(sql`select 1`);
        return undefined;
      },
    },
    {
      name: 'redis',
      probe: () => queueHandle.healthClient.ping(),
    },
    {
      name: 'couriers',
      probe: () => {
        const ids = registry.ids();
        if (ids.length === 0) {
          throw new Error('no courier partners are registered');
        }
        return Promise.resolve(ids.join(', '));
      },
    },
  ];

  return {
    config,
    logger,
    errorHandler,
    db,
    registry,
    orderService,
    trackingService,
    bulkService,
    controller,
    couriersController,
    bulkQueue,
    queueHandle,
    healthChecks,
    shutdown: async () => {
      await bulkQueue.close();
      queueHandle.disconnect();
      await pool.end();
    },
  };
}

// Every courier gets retry configuration for free by naming convention, so adding one means adding
// env vars rather than editing this file.
function retryOptionsFor(courierId: string, env: NodeJS.ProcessEnv): RetryOptions {
  const prefix = courierId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    attempts: positiveInt(env[`${prefix}_RETRY_ATTEMPTS`], 3),
    backoffMs: positiveInt(env[`${prefix}_RETRY_BACKOFF_MS`], 500),
    maxBackoffMs: positiveInt(env[`${prefix}_RETRY_MAX_BACKOFF_MS`], 10_000),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
