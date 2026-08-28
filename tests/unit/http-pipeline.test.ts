import type { RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from '../../src/app.js';
import type { CouriersController } from '../../src/components/couriers/index.js';
import type { OrdersController } from '../../src/components/orders/index.js';
import { loadConfig } from '../../src/libraries/config/index.js';
import { ErrorHandler } from '../../src/libraries/errors/index.js';
import { createLogger } from '../../src/libraries/logger/index.js';

const reached: RequestHandler = (_req, res) => {
  res.status(201).json({ success: true, data: { reached: true } });
};

const ordersController: OrdersController = {
  create: reached,
  bulkCreate: reached,
  list: reached,
  get: reached,
  track: reached,
  cancel: reached,
  retry: reached,
  batchStatus: reached,
};

const couriersController: CouriersController = { list: reached, serviceability: reached };

function appWith(overrides: NodeJS.ProcessEnv = {}) {
  const logger = createLogger({ level: 'silent', pretty: false });
  const dependencies: AppDependencies = {
    config: loadConfig({
      DATABASE_URL: 'postgres://unused',
      REDIS_URL: 'redis://unused',
      LOG_LEVEL: 'silent',
      ...overrides,
    }),
    logger,
    errorHandler: new ErrorHandler(logger),
    controller: ordersController,
    couriersController,
    healthChecks: [],
  };
  return createApp(dependencies);
}

describe('request pipeline', () => {
  it('answers a body that is not JSON with 400 rather than 500', async () => {
    const response = await request(appWith())
      .post('/api/v1/orders')
      .set('content-type', 'application/json')
      .send('{"order_id": ');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MALFORMED_JSON');
  });

  it('correlates a parse failure with a request id', async () => {
    const response = await request(appWith())
      .post('/api/v1/orders')
      .set('content-type', 'application/json')
      .set('x-request-id', 'req_from_caller')
      .send('nonsense');

    expect(response.body.request_id).toBe('req_from_caller');
    expect(response.headers['x-request-id']).toBe('req_from_caller');
  });

  it('answers an oversized body with 413 and names the limit', async () => {
    const response = await request(appWith({ REQUEST_BODY_LIMIT: '1kb' }))
      .post('/api/v1/orders')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(4096) }));

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(response.body.error.message).toContain('1kb');
  });

  it('rejects a wrong API key of the same length as the real one', async () => {
    const response = await request(appWith({ API_KEY: 'secret-key-value' }))
      .get('/api/v1/couriers')
      .set('x-api-key', 'wrong!key!value!');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong API key of a different length without throwing', async () => {
    const response = await request(appWith({ API_KEY: 'secret-key-value' }))
      .get('/api/v1/couriers')
      .set('x-api-key', 'x');

    expect(response.status).toBe(401);
  });

  it('lets the correct API key through', async () => {
    const response = await request(appWith({ API_KEY: 'secret-key-value' }))
      .get('/api/v1/couriers')
      .set('x-api-key', 'secret-key-value');

    expect(response.status).toBe(201);
  });

  it('leaves liveness reachable without a key', async () => {
    const response = await request(appWith({ API_KEY: 'secret-key-value' })).get('/health');

    expect(response.status).toBe(200);
  });
});
