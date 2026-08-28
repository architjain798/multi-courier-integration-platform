import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from '../logger/index.js';

export const BULK_CREATE_QUEUE = 'bulk-create';

type RedisTarget = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
};

export type QueueHandle = {
  healthClient: Redis;
  options: ConnectionOptions;
  logger: Logger;
  disconnect: () => void;
};

// BullMQ is given connection options rather than a client on purpose. Handed a client it duplicates
// it for blocking commands, and those duplicates carry no 'error' listener — an unlistened ioredis
// 'error' becomes an uncaught exception, so a Redis blip takes the whole API down. Letting BullMQ
// own its clients also gives each Queue and Worker its own socket, which is what allows a worker to
// resume after Redis returns instead of sitting on a dead blocking read.
export function createQueueConnection(redisUrl: string, logger: Logger): QueueHandle {
  const target = parseRedisUrl(redisUrl);

  const healthClient = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  healthClient.on('error', (error: Error) => {
    logger.warn({ err: error, component: 'redis' }, 'Redis connection error');
  });

  const options: ConnectionOptions = { ...target, maxRetriesPerRequest: null };

  return {
    healthClient,
    options,
    logger,
    disconnect: () => {
      healthClient.disconnect();
    },
  };
}

export function createQueue<T>(name: string, handle: QueueHandle): Queue<T> {
  const queue = new Queue<T>(name, { connection: handle.options });
  queue.on('error', (error: Error) => {
    handle.logger.warn({ err: error, component: 'queue', queue: name }, 'Queue connection error');
  });
  return queue;
}

export function createWorker<T>(
  name: string,
  handle: QueueHandle,
  processor: Processor<T>,
  concurrency: number,
): Worker<T> {
  const worker = new Worker<T>(name, processor, { connection: handle.options, concurrency });
  worker.on('error', (error: Error) => {
    handle.logger.warn({ err: error, component: 'worker', queue: name }, 'Worker connection error');
  });
  return worker;
}

function parseRedisUrl(redisUrl: string): RedisTarget {
  const url = new URL(redisUrl);
  const database = url.pathname.replace(/^\//, '');

  return {
    host: url.hostname,
    port: url.port.length > 0 ? Number(url.port) : 6379,
    ...(url.username.length > 0 ? { username: url.username } : {}),
    ...(url.password.length > 0 ? { password: url.password } : {}),
    ...(database.length > 0 ? { db: Number(database) } : {}),
  };
}

export type SupervisedWorker = {
  close: () => Promise<void>;
};

export type SuperviseOptions<T> = {
  name: string;
  handle: QueueHandle;
  queue: Queue<T>;
  processor: Processor<T>;
  concurrency: number;
  checkIntervalMs: number;
};

// A BullMQ worker that loses Redis mid-blocking-read comes back reporting isRunning() === true
// while silently consuming nothing: a job added after the outage is never picked up. Reproduced
// against bullmq 6 with a plain Queue/Worker pair, so isRunning() cannot be used as the signal.
// This watches the queue instead — jobs waiting with nothing active across two consecutive checks
// means the worker is not reading, and it is replaced.
export function superviseWorker<T>(options: SuperviseOptions<T>): SupervisedWorker {
  const { name, handle, queue, processor, concurrency, checkIntervalMs } = options;
  const logger = handle.logger;

  let worker = createWorker<T>(name, handle, processor, concurrency);
  let stalledChecks = 0;
  let closing = false;

  const timer = setInterval(() => {
    void (async () => {
      if (closing) {
        return;
      }

      try {
        const [waiting, active] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
        ]);

        if (waiting === 0 || active > 0) {
          stalledChecks = 0;
          return;
        }

        stalledChecks += 1;
        if (stalledChecks < 2) {
          return;
        }

        logger.warn(
          { queue: name, waiting },
          'Worker is not consuming a non-empty queue, replacing it',
        );
        const previous = worker;
        worker = createWorker<T>(name, handle, processor, concurrency);
        stalledChecks = 0;
        await previous.close(true);
      } catch (error) {
        // Redis itself is unreachable, which the readiness probe already reports. Nothing to
        // replace until it returns.
        logger.debug({ err: error, queue: name }, 'Queue depth check failed');
      }
    })();
  }, checkIntervalMs);
  timer.unref();

  return {
    close: async () => {
      closing = true;
      clearInterval(timer);
      await worker.close();
    },
  };
}
