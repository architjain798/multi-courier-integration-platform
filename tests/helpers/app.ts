import type { Express } from 'express';

import { createApp } from '../../src/app.js';
import { createContainer, type Container } from '../../src/container.js';
import { loadConfig } from '../../src/libraries/config/index.js';

import type { SupervisedWorker } from '../../src/libraries/queue/index.js';
import { startBulkWorker } from '../../src/worker.js';
import type { Infrastructure } from './infrastructure.js';

export const URBANEBOLT_BASE_URL = 'https://uat.urbanebolt.test';

export type TestHarness = {
  app: Express;
  container: Container;
  worker: SupervisedWorker | null;
  stop: () => Promise<void>;
};

export function buildHarness(
  infrastructure: Infrastructure,
  overrides: NodeJS.ProcessEnv = {},
  options: { withWorker?: boolean } = {},
): TestHarness {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: infrastructure.databaseUrl,
    REDIS_URL: infrastructure.redisUrl,
    URBANEBOLT_ENABLED: 'true',
    URBANEBOLT_BASE_URL,
    URBANEBOLT_USERNAME: 'test-user',
    URBANEBOLT_PASSWORD: 'test-pass',
    URBANEBOLT_CUSTOMER_CODE: 'UEBCUS0008',
    URBANEBOLT_RETRY_ATTEMPTS: '2',
    URBANEBOLT_RETRY_BACKOFF_MS: '1',
    URBANEBOLT_RETRY_MAX_BACKOFF_MS: '2',
    URBANEBOLT_MAX_BATCH_SIZE: '15',
    MOCK_ENABLED: 'true',
    TRACKING_TTL_SECONDS: '0',
    BULK_JOB_ATTEMPTS: '1',
    BULK_STALL_CHECK_MS: '2000',
    BULK_BACKOFF_MS: '1',
    ...overrides,
  };

  const container = createContainer(loadConfig(env), env);
  const worker = options.withWorker === true ? startBulkWorker(container) : null;

  return {
    app: createApp(container),
    container,
    worker,
    stop: async () => {
      await worker?.close();
      await container.shutdown();
    },
  };
}
