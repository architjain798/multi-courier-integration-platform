import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/libraries/config/index.js';
import { AppError } from '../../src/libraries/errors/index.js';

const minimalEnv = {
  DATABASE_URL: 'postgres://localhost:5432/courier',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('applies defaults for everything that is not required', () => {
    const config = loadConfig(minimalEnv);

    expect(config.env).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.bulk.maxOrders).toBe(100);
    expect(config.trackingTtlSeconds).toBe(60);
    expect(config.apiKey).toBeUndefined();
  });

  it('coerces numeric and boolean strings out of the environment', () => {
    const config = loadConfig({
      ...minimalEnv,
      PORT: '8080',
      BULK_WORKER_CONCURRENCY: '12',
      WORKER_INLINE: 'true',
      DEBUG_COURIER_ERRORS: 'false',
    });

    expect(config.port).toBe(8080);
    expect(config.bulk.workerConcurrency).toBe(12);
    expect(config.workerInline).toBe(true);
    expect(config.debugCourierErrors).toBe(false);
  });

  it('fails fast and names the missing variable', () => {
    let thrown: unknown;
    try {
      loadConfig({ REDIS_URL: 'redis://localhost:6379' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    expect(appError.isOperational).toBe(false);
    expect(appError.details).toContainEqual(expect.objectContaining({ field: 'DATABASE_URL' }));
  });

  it('rejects a port that is not a positive integer', () => {
    expect(() => loadConfig({ ...minimalEnv, PORT: '-1' })).toThrow(AppError);
    expect(() => loadConfig({ ...minimalEnv, PORT: 'http' })).toThrow(AppError);
  });

  it('rejects an unrecognised log level rather than silently defaulting', () => {
    expect(() => loadConfig({ ...minimalEnv, LOG_LEVEL: 'verbose' })).toThrow(AppError);
  });
});

describe('blank environment variables', () => {
  it('treats a bare KEY= as unset rather than an invalid empty string', () => {
    const config = loadConfig({ ...minimalEnv, API_KEY: '' });

    expect(config.apiKey).toBeUndefined();
  });

  it('falls back to the default when an optional variable is blank', () => {
    const config = loadConfig({ ...minimalEnv, LOG_LEVEL: '', BULK_MAX_ORDERS: '' });

    expect(config.logLevel).toBe('info');
    expect(config.bulk.maxOrders).toBe(100);
  });
});
