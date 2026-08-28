import { eq } from 'drizzle-orm';
import nock from 'nock';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { orders } from '../../src/components/orders/data-access/schema.js';
import { buildHarness, URBANEBOLT_BASE_URL, type TestHarness } from '../helpers/app.js';
import { startInfrastructure, type Infrastructure } from '../helpers/infrastructure.js';

let infrastructure: Infrastructure;
let harness: TestHarness;

beforeAll(async () => {
  infrastructure = await startInfrastructure();
  harness = buildHarness(infrastructure);
  nock.disableNetConnect();
  nock.enableNetConnect((host) => host.includes('127.0.0.1') || host.includes('localhost'));
}, 180_000);

afterAll(async () => {
  nock.cleanAll();
  nock.enableNetConnect();
  await harness.stop();
  await infrastructure.stop();
}, 60_000);

afterEach(() => {
  nock.cleanAll();
});

let counter = 0;
const nextOrderId = (prefix: string): string => `${prefix}-${Date.now()}-${counter++}`;

const address = (over: Record<string, unknown> = {}) => ({
  name: 'Rohit Athaley',
  phone: '9425018023',
  line1: 'Plot 137 Sector-I Industrial Area',
  city: 'Gurgaon',
  state: 'Haryana',
  pincode: '122017',
  country: 'INDIA',
  type: 'SELLER',
  ...over,
});

const orderPayload = (orderId: string, courier = 'urbanebolt') => ({
  courier_partner: courier,
  order_id: orderId,
  payment_mode: 'COD',
  service_level: 'SAME_DAY',
  collectable_amount: 1499,
  declared_value: 1499,
  invoice: { number: 'INV-1', date: '2026-08-27', value: 1499 },
  pickup: address(),
  delivery: address({ name: 'Consignee', pincode: '122001', type: 'HOME', phone: '8320226438' }),
  package: { weight_kg: 1.1, length_cm: 12, breadth_cm: 10, height_cm: 10, pieces: 1 },
  items: [{ description: 'Books', quantity: 1 }],
});

function stubToken(times = 1): nock.Scope {
  return nock(URBANEBOLT_BASE_URL)
    .post('/api/v1/auth/getToken/')
    .times(times)
    .reply(200, { access_token: 'test-token', expires_in: 86_400, status: 'Success' });
}

function manifestSuccess(orderId: string, awb: string) {
  return {
    status: 'Success',
    successResponse: [
      {
        orderNumber: orderId,
        awbNumber: Number(awb),
        customerCode: 'UEBCUS0008',
        shippingLabel: 'https://label',
      },
    ],
    errorResponse: [],
  };
}

describe('POST /api/v1/orders', () => {
  it('creates a shipment and stores the AWB', async () => {
    const orderId = nextOrderId('OK');
    stubToken();
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, manifestSuccess(orderId, '200000001111'));

    const response = await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    expect(response.status).toBe(201);
    expect(response.body.data.awb).toBe('200000001111');
    expect(response.body.data.status).toBe('CREATED');
    expect(response.body.data.label_url).toBe('https://label');
  });

  it('sends UrbaneBolt its own vocabulary, not ours', async () => {
    const orderId = nextOrderId('MAP');
    stubToken();
    let sent: unknown;
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/', (body: unknown) => {
        sent = body;
        return true;
      })
      .reply(200, manifestSuccess(orderId, '200000001112'));

    await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    const [item] = sent as Record<string, unknown>[];
    expect(item?.serviceType).toBe('SDD');
    expect(item?.payMode).toBe('COD');
    expect(item?.customerCode).toBe('UEBCUS0008');
    expect(item?.consPincode).toBe(122001);
    expect(item?.shprMobile).toBe(9425018023);
    expect(item).not.toHaveProperty('service_level');
  });

  it('maps a 200-with-status-Failed body to a 422 without leaking the courier wording', async () => {
    const orderId = nextOrderId('FAIL');
    stubToken();
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, {
        status: 'Success',
        successResponse: [],
        errorResponse: [
          { orderNumber: orderId, message: 'Consignee Pincode 999999 is not serviceable' },
        ],
      });

    const response = await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PINCODE_NOT_SERVICEABLE');
    expect(response.body.error.courier_partner).toBe('urbanebolt');
    expect(JSON.stringify(response.body)).not.toContain('999999');
  });

  it('persists the failure so it can be reconciled later', async () => {
    const orderId = nextOrderId('PERSIST');
    stubToken();
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, {
        status: 'Success',
        successResponse: [],
        errorResponse: [{ orderNumber: orderId, message: "'shprName' is a required property" }],
      });

    await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));
    const stored = await request(harness.app).get(`/api/v1/orders/${orderId}`);

    expect(stored.body.data.status).toBe('FAILED');
    expect(stored.body.data.failure.code).toBe('COURIER_VALIDATION_ERROR');
    expect(stored.body.data.failure.message).toBe('The courier rejected the shipment details');
    expect(JSON.stringify(stored.body)).not.toContain('shprName');
  });

  it('keeps the courier wording in the database while withholding it from the response', async () => {
    const orderId = nextOrderId('KEEPRAW');
    stubToken();
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, {
        status: 'Success',
        successResponse: [],
        errorResponse: [{ orderNumber: orderId, message: "'shprName' is a required property" }],
      });

    await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    const [row] = await harness.container.db
      .select()
      .from(orders)
      .where(eq(orders.orderId, orderId));

    expect(row?.failureMessage).toContain('shprName');
  });

  it('re-authenticates once and retries when the token has expired', async () => {
    const orderId = nextOrderId('AUTH');
    stubToken(2);
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(401, { detail: 'Authentication credentials were not provided.' });
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, manifestSuccess(orderId, '200000001113'));

    const response = await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    expect(response.status).toBe(201);
    expect(response.body.data.awb).toBe('200000001113');
  });

  it('retries a 502 with backoff and then fails gracefully', async () => {
    const orderId = nextOrderId('FLAKY');
    stubToken(2);
    nock(URBANEBOLT_BASE_URL).post('/api/v1/services/manifest/').times(2).reply(502, 'bad gateway');

    const response = await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('COURIER_UNAVAILABLE');
    expect(response.body.error.retryable).toBe(true);
  });

  it('recovers when the courier fails once and then succeeds', async () => {
    const orderId = nextOrderId('RECOVER');
    stubToken(2);
    nock(URBANEBOLT_BASE_URL).post('/api/v1/services/manifest/').reply(502, 'bad gateway');
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, manifestSuccess(orderId, '200000001114'));

    const response = await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    expect(response.status).toBe(201);
    expect(response.body.data.awb).toBe('200000001114');
  });

  it('flags a courier-side duplicate as needing reconciliation', async () => {
    const orderId = nextOrderId('DUP');
    stubToken();
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, {
        status: 'Success',
        successResponse: [],
        errorResponse: [{ orderNumber: orderId, message: 'orderNumber already shipped!' }],
      });

    const response = await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));
    const stored = await request(harness.app).get(`/api/v1/orders/${orderId}`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DUPLICATE_AT_COURIER');
    expect(stored.body.data.status).toBe('RECONCILIATION_REQUIRED');
  });

  it('refuses to auto-retry an order that needs reconciliation', async () => {
    const orderId = nextOrderId('NORETRY');
    stubToken();
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, {
        status: 'Success',
        successResponse: [],
        errorResponse: [{ orderNumber: orderId, message: 'orderNumber already shipped!' }],
      });

    await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));
    const retried = await request(harness.app).post(`/api/v1/orders/${orderId}/retry`).send({});

    expect(retried.status).toBe(409);
    expect(retried.body.error.code).toBe('RECONCILIATION_REQUIRED');
  });

  it('replays the original result for a repeated order_id instead of shipping twice', async () => {
    const orderId = nextOrderId('IDEM');
    stubToken();
    const manifest = nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .once()
      .reply(200, manifestSuccess(orderId, '200000001115'));

    const first = await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));
    const second = await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.idempotent_replay).toBe(true);
    expect(second.body.data.awb).toBe(first.body.data.awb);
    expect(manifest.isDone()).toBe(true);
  });

  it('rejects an unknown courier with the list of supported ones', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders')
      .send(orderPayload(nextOrderId('UNK'), 'bluedart'));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UNKNOWN_COURIER_PARTNER');
    expect(response.body.error.details[0].supported).toEqual(
      expect.arrayContaining(['mock', 'urbanebolt']),
    );
  });

  it('returns field-level detail for a malformed body', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders')
      .send({ courier_partner: 'mock', order_id: 'X', payment_mode: 'CASH' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'payment_mode' }),
    );
  });

  it('rejects an unknown field instead of silently dropping it', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders')
      .send({ ...orderPayload(nextOrderId('STRICT'), 'mock'), collectible_amount: 999 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ issue: 'unrecognized_keys' }),
    );
  });

  it('requires a collectable amount on a COD shipment', async () => {
    const response = await request(harness.app)
      .post('/api/v1/orders')
      .send({ ...orderPayload(nextOrderId('COD'), 'mock'), collectable_amount: 0 });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'collectable_amount' }),
    );
  });
});

describe('tracking', () => {
  it('appends only genuinely new scans when the courier is polled twice', async () => {
    const orderId = nextOrderId('TRACK');
    stubToken(3);
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, manifestSuccess(orderId, '200000002222'));

    const trackingBody = (scans: unknown[]) => ({
      status: 'Success',
      message: 'Tracking',
      data: {
        awbNumber: 200000002222,
        currentStatusCode: 'MAN',
        currentStatusCodeDescription: 'Shipment Manifested',
        scans,
      },
    });
    const manifested = {
      statusDateTime: '27 Aug 2026, 15:44',
      statusCode: 'MAN',
      statusCodeDescription: 'Shipment Manifested',
      currentLocation: 'Gurgaon',
    };
    const pickedUp = {
      statusDateTime: '27 Aug 2026, 18:10',
      statusCode: 'PKD',
      statusCodeDescription: 'Picked Up',
      currentLocation: 'Gurgaon',
    };

    await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    nock(URBANEBOLT_BASE_URL)
      .get('/api/v1/services/tracking-pub/')
      .query(true)
      .reply(200, trackingBody([manifested]));
    const first = await request(harness.app).get(`/api/v1/orders/${orderId}/track`);

    nock(URBANEBOLT_BASE_URL)
      .get('/api/v1/services/tracking-pub/')
      .query(true)
      .reply(200, trackingBody([pickedUp, manifested]));
    const second = await request(harness.app).get(`/api/v1/orders/${orderId}/track`);

    expect(first.body.data.history).toHaveLength(1);
    expect(second.body.data.history).toHaveLength(2);
    expect(second.body.data.history[0].courier_status_code).toBe('MAN');
    expect(second.body.data.history[0].event_time).toBe('2026-08-27T10:14:00.000Z');
    expect(second.body.data.history[1].status).toBe('PICKED_UP');
  });

  it('records an unrecognised courier code as UNKNOWN instead of failing', async () => {
    const orderId = nextOrderId('WEIRD');
    stubToken(2);
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, manifestSuccess(orderId, '200000002223'));
    await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    nock(URBANEBOLT_BASE_URL)
      .get('/api/v1/services/tracking-pub/')
      .query(true)
      .reply(200, {
        status: 'Success',
        data: {
          awbNumber: 200000002223,
          currentStatusCode: 'QQQ',
          scans: [{ statusDateTime: '27 Aug 2026, 19:00', statusCode: 'QQQ' }],
        },
      });

    const response = await request(harness.app).get(`/api/v1/orders/${orderId}/track`);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('UNKNOWN');
    expect(response.body.data.history[0].courier_status_code).toBe('QQQ');
  });

  it('refuses to track an order that never reached a courier', async () => {
    const orderId = nextOrderId('NOAWB');
    stubToken();
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, {
        status: 'Success',
        successResponse: [],
        errorResponse: [
          { orderNumber: orderId, message: 'Consignee Pincode 999999 is not serviceable' },
        ],
      });
    await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    const response = await request(harness.app).get(`/api/v1/orders/${orderId}/track`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SHIPMENT_NOT_TRACKABLE');
  });
});

describe('cancellation', () => {
  it('cancels a created shipment and refuses a second attempt', async () => {
    const orderId = nextOrderId('CANCEL');
    stubToken(2);
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, manifestSuccess(orderId, '200000003333'));
    await request(harness.app).post('/api/v1/orders').send(orderPayload(orderId));

    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/cancel/')
      .reply(200, {
        status: 'Success',
        message: 'Cancellation Proccess',
        successResponse: [{ orderNumber: orderId, awb: '200000003333', message: 'Cancelled' }],
        failureResponse: [],
      });

    const cancelled = await request(harness.app).post(`/api/v1/orders/${orderId}/cancel`).send({});
    const again = await request(harness.app).post(`/api/v1/orders/${orderId}/cancel`).send({});

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SHIPMENT_NOT_CANCELLABLE');
  });
});

describe('supporting endpoints', () => {
  it('lists couriers with their capabilities', async () => {
    const response = await request(harness.app).get('/api/v1/couriers');

    expect(response.status).toBe(200);
    const urbanebolt = response.body.data.couriers.find(
      (courier: { id: string }) => courier.id === 'urbanebolt',
    );
    expect(urbanebolt.capabilities.supports_batch_create).toBe(true);
    expect(urbanebolt.capabilities.max_batch_size).toBe(15);
  });

  it('reports that MockCourier cannot check serviceability', async () => {
    const response = await request(harness.app).get(
      '/api/v1/serviceability?courier_partner=mock&pincodes=122001',
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OPERATION_NOT_SUPPORTED');
  });

  it('serves the generated OpenAPI document', async () => {
    const response = await request(harness.app).get('/docs/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths)).toContain('/api/v1/orders');
  });

  it('returns ROUTE_NOT_FOUND for an unmatched path', async () => {
    const response = await request(harness.app).get('/api/v1/nope');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(response.body.request_id).toMatch(/^req_/);
  });
});

describe('health probes', () => {
  it('answers liveness without touching a dependency', async () => {
    const response = await request(harness.app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.version).toBe('1.0.0');
    expect(response.body.data).not.toHaveProperty('checks');
  });

  it('reports every dependency on the readiness probe', async () => {
    const response = await request(harness.app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ready');

    const checks = response.body.data.checks as {
      name: string;
      status: string;
      detail?: string;
    }[];
    expect(checks.map((check) => check.name).sort()).toEqual(['couriers', 'postgres', 'redis']);
    expect(checks.every((check) => check.status === 'up')).toBe(true);
    expect(checks.find((check) => check.name === 'couriers')?.detail).toContain('urbanebolt');
  });

  it('reports 503 and names the failing dependency when a probe throws', async () => {
    const broken = buildHarness(infrastructure);
    broken.container.healthChecks.push({
      name: 'flaky-dependency',
      probe: () => Promise.reject(new Error('connection refused')),
    });

    const response = await request(broken.app).get('/health/ready');
    await broken.stop();

    expect(response.status).toBe(503);
    expect(response.body.data.status).toBe('degraded');
    const failing = (response.body.data.checks as { name: string; error?: string }[]).find(
      (check) => check.name === 'flaky-dependency',
    );
    expect(failing?.error).toBe('connection refused');
  });

  it('reports a hanging dependency as down instead of hanging the probe', async () => {
    const stuck = buildHarness(infrastructure);
    stuck.container.healthChecks.push({
      name: 'never-answers',
      probe: () => new Promise(() => undefined),
    });

    const startedAt = Date.now();
    const response = await request(stuck.app).get('/health/ready');
    const elapsed = Date.now() - startedAt;
    await stuck.stop();

    expect(response.status).toBe(503);
    expect(elapsed).toBeLessThan(5_000);
    const failing = (
      response.body.data.checks as { name: string; status: string; error?: string }[]
    ).find((check) => check.name === 'never-answers');
    expect(failing?.status).toBe('down');
    expect(failing?.error).toContain('did not answer within');
  }, 15_000);

  it('leaves both probes reachable when the API key guard is on', async () => {
    const guarded = buildHarness(infrastructure, { API_KEY: 'secret' });

    const live = await request(guarded.app).get('/health');
    const ready = await request(guarded.app).get('/health/ready');
    const docs = await request(guarded.app).get('/docs/openapi.json');
    const orders = await request(guarded.app).get('/api/v1/orders');
    await guarded.stop();

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(docs.status).toBe(200);
    expect(orders.status).toBe(401);
  });
});
