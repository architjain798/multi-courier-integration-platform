import type { Queue } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createQueue,
  createQueueConnection,
  superviseWorker,
  type QueueHandle,
} from '../../src/libraries/queue/index.js';
import { startInfrastructure, type Infrastructure } from '../helpers/infrastructure.js';

type Payload = { id: number };

let infrastructure: Infrastructure;
let handle: QueueHandle;

beforeAll(async () => {
  infrastructure = await startInfrastructure();
  handle = createQueueConnection(infrastructure.redisUrl, pino({ enabled: false }));
}, 180_000);

afterAll(async () => {
  handle.disconnect();
  await infrastructure.stop();
}, 60_000);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('superviseWorker', () => {
  it('drains a backlog that already existed before the worker started', async () => {
    const name = `supervisor-backlog-${Date.now()}`;
    const queue: Queue<Payload> = createQueue<Payload>(name, handle);

    await queue.addBulk(
      Array.from({ length: 5 }, (_, index) => ({ name: 'chunk', data: { id: index } })),
    );
    expect(await queue.getWaitingCount()).toBe(5);

    const seen: number[] = [];
    const supervised = superviseWorker<Payload>({
      name,
      handle,
      queue,
      processor: (job) => {
        seen.push(job.data.id);
        return Promise.resolve();
      },
      concurrency: 2,
      checkIntervalMs: 500,
    });

    const deadline = Date.now() + 10_000;
    while (seen.length < 5 && Date.now() < deadline) {
      await wait(100);
    }

    await supervised.close();
    await queue.obliterate({ force: true });
    await queue.close();

    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  }, 30_000);

  it('stops consuming once closed', async () => {
    const name = `supervisor-close-${Date.now()}`;
    const queue: Queue<Payload> = createQueue<Payload>(name, handle);

    let processed = 0;
    const supervised = superviseWorker<Payload>({
      name,
      handle,
      queue,
      processor: () => {
        processed += 1;
        return Promise.resolve();
      },
      concurrency: 1,
      checkIntervalMs: 500,
    });

    await queue.add('chunk', { id: 1 });
    const deadline = Date.now() + 10_000;
    while (processed < 1 && Date.now() < deadline) {
      await wait(100);
    }
    expect(processed).toBe(1);

    await supervised.close();
    await queue.add('chunk', { id: 2 });
    await wait(1500);

    expect(processed).toBe(1);
    expect(await queue.getWaitingCount()).toBe(1);

    await queue.obliterate({ force: true });
    await queue.close();
  }, 30_000);
});
