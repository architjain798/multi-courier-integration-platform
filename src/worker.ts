import 'dotenv/config';

import { createBulkChunkProcessor } from './components/orders/entry-points/queue/bulk-create.processor.js';
import type { BulkChunkJob } from './components/orders/index.js';
import { createContainer, type Container } from './container.js';
import { loadConfig } from './libraries/config/index.js';
import { isAppError } from './libraries/errors/index.js';
import { createLogger } from './libraries/logger/index.js';
import {
  BULK_CREATE_QUEUE,
  superviseWorker,
  type SupervisedWorker,
} from './libraries/queue/index.js';

export function startBulkWorker(container: Container): SupervisedWorker {
  const processor = createBulkChunkProcessor(
    container.bulkService,
    container.errorHandler,
    container.logger,
  );

  return superviseWorker<BulkChunkJob>({
    name: BULK_CREATE_QUEUE,
    handle: container.queueHandle,
    queue: container.bulkQueue,
    processor,
    concurrency: container.config.bulk.workerConcurrency,
    checkIntervalMs: container.config.bulk.stallCheckMs,
  });
}

function main(): void {
  const bootstrapLogger = createLogger({
    level: 'info',
    pretty: process.env.LOG_PRETTY === 'true',
  });

  let container: Container;
  try {
    container = createContainer(loadConfig());
  } catch (error) {
    bootstrapLogger.fatal(
      { invalid: isAppError(error) ? error.details : undefined, err: error },
      'Worker failed to start',
    );
    process.exit(1);
  }

  const worker = startBulkWorker(container);
  container.logger.info(
    { queue: BULK_CREATE_QUEUE, concurrency: container.config.bulk.workerConcurrency },
    'Bulk worker started',
  );

  const shutdown = (signal: string): void => {
    const timeoutMs = container.config.shutdownTimeoutMs;
    container.logger.info({ signal, timeoutMs }, 'Stopping worker');

    // close() drains whatever job is in flight, and a job is a courier call that can hang for as
    // long as the courier lets it. The bound is what keeps a deploy from stalling on one bad call.
    const forced = setTimeout(() => {
      container.logger.error({ signal }, 'Worker did not stop in time, exiting anyway');
      process.exit(1);
    }, timeoutMs);

    void (async () => {
      try {
        await worker.close();
        await container.shutdown();
      } catch (error) {
        container.errorHandler.handle(error, { source: 'shutdown' });
      }
      clearTimeout(forced);
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

// Only run standalone when this file is the process entrypoint; server.ts imports startBulkWorker
// for the WORKER_INLINE path.
if (
  process.argv[1]?.endsWith('worker.ts') === true ||
  process.argv[1]?.endsWith('worker.js') === true
) {
  main();
}
