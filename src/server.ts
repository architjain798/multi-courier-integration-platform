import 'dotenv/config';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { createContainer, type Container } from './container.js';
import { loadConfig, type AppConfig } from './libraries/config/index.js';
import { isAppError } from './libraries/errors/index.js';
import { createLogger } from './libraries/logger/index.js';
import { startBulkWorker } from './worker.js';

const bootstrapLogger = createLogger({
  level: 'info',
  pretty: process.env.LOG_PRETTY === 'true',
});

let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  bootstrapLogger.fatal(
    { invalid: isAppError(error) ? error.details : undefined, err: error },
    'Invalid environment configuration',
  );
  process.exit(1);
}

let container: Container;
try {
  container = createContainer(config);
} catch (error) {
  bootstrapLogger.fatal(
    { invalid: isAppError(error) ? error.details : undefined, err: error },
    'Failed to build the application container',
  );
  process.exit(1);
}

const { logger, errorHandler } = container;
const app = createApp(container);
const inlineWorker = config.workerInline ? startBulkWorker(container) : null;

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.env,
      couriers: container.registry.ids(),
      workerInline: config.workerInline,
    },
    'API listening',
  );
});

installProcessHandlers(server);

function installProcessHandlers(httpServer: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal, timeoutMs: config.shutdownTimeoutMs }, 'Shutting down');

    // close() waits for every open connection, and a keep-alive socket held by a load balancer
    // never closes on its own. Unbounded, the container sits there until the orchestrator SIGKILLs
    // it, which drops in-flight requests rather than draining them.
    const forced = setTimeout(() => {
      logger.error({ signal }, 'Shutdown did not finish in time, exiting anyway');
      process.exit(1);
    }, config.shutdownTimeoutMs);

    httpServer.closeIdleConnections();
    httpServer.close(() => {
      void (async () => {
        try {
          await inlineWorker?.close();
          await container.shutdown();
        } catch (error) {
          errorHandler.handle(error, { source: 'shutdown' });
        }
        clearTimeout(forced);
        process.exit(0);
      })();
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  process.on('unhandledRejection', (reason) => {
    errorHandler.handle(reason, { source: 'unhandledRejection' });
  });

  process.on('uncaughtException', (error) => {
    const normalized = errorHandler.handle(error, { source: 'uncaughtException' });
    if (!normalized.isOperational) {
      process.exit(1);
    }
  });
}
