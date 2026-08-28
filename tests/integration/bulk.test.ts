import nock from 'nock';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildHarness, URBANEBOLT_BASE_URL, type TestHarness } from '../helpers/app.js';
import { startInfrastructure, type Infrastructure } from '../helpers/infrastructure.js';

let infrastructure: Infrastructure;
let harness: TestHarness;

beforeAll(async () => {
  infrastructure = await startInfrastructure();
  harness = buildHarness(infrastructure, {}, { withWorker: true });
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

const address = () => ({
  name: 'Shipper',
  phone: '9425018023',
  line1: 'Plot 137 Sector-I',
  city: 'Gurgaon',
  state: 'Haryana',
  pincode: '122017',
  country: 'INDIA',
  type: 'SELLER' as const,
});

const orderPayload = (orderId: string, courier: string) => ({
  courier_partner: courier,
  order_id: orderId,
  payment_mode: 'PREPAID',
  service_level: 'NEXT_DAY',
  collectable_amount: 0,
  declared_value: 500,
  invoice: { number: 'INV-1', date: '2026-08-27', value: 500 },
  pickup: address(),
  delivery: { ...address(), pincode: '122001', type: 'HOME' as const },
  package: { weight_kg: 1, length_cm: 10, breadth_cm: 10, height_cm: 10, pieces: 1 },
  items: [{ description: 'Widget', quantity: 1 }],
});

async function waitForBatch(batchId: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let body: Record<string, unknown> = {};

  while (Date.now() < deadline) {
    const response = await request(harness.app).get(`/api/v1/batches/${batchId}`);
    body = response.body.data;
    if (body.status !== 'PROCESSING') {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return body;
}

describe('POST /api/v1/orders/bulk', () => {
  it('rejects invalid items inline and still queues the good ones', async () => {
    const stamp = `INLINE-${Date.now()}`;
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/auth/getToken/')
      .times(5)
      .reply(200, { access_token: 't', expires_in: 86_400, status: 'Success' });

    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, {
        status: 'Success',
        successResponse: [
          { orderNumber: `${stamp}-A`, awbNumber: 200000030001, customerCode: 'UEBCUS0008' },
        ],
        errorResponse: [],
      });

    const good = orderPayload(`${stamp}-A`, 'urbanebolt');
    const response = await request(harness.app)
      .post('/api/v1/orders/bulk')
      .send({
        orders: [
          good,
          { courier_partner: 'urbanebolt', order_id: `${stamp}-BAD` },
          orderPayload(`${stamp}-A`, 'urbanebolt'),
          orderPayload(`${stamp}-C`, 'nonexistent'),
        ],
      });

    expect(response.status).toBe(202);
    expect(response.body.data.accepted_count).toBe(1);
    expect(response.body.data.rejected_count).toBe(3);
    expect(response.body.data.status_url).toBe(`/api/v1/batches/${response.body.data.batch_id}`);

    const codes = response.body.data.rejected.map((item: { code: string }) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'VALIDATION_ERROR',
        'DUPLICATE_IN_REQUEST',
        'UNKNOWN_COURIER_PARTNER',
      ]),
    );

    // Let the queued chunk finish before the suite moves on, so its courier call cannot land in
    // the middle of the next test's interceptors.
    const batch = await waitForBatch(response.body.data.batch_id);
    expect(batch.status).toBe('COMPLETED');
  }, 40_000);

  it('chunks a large UrbaneBolt batch into native manifest calls instead of one call per order', async () => {
    const stamp = `CHUNK-${Date.now()}`;
    const orders = Array.from({ length: 20 }, (_, index) =>
      orderPayload(`${stamp}-${index}`, 'urbanebolt'),
    );

    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/auth/getToken/')
      .times(10)
      .reply(200, { access_token: 't', expires_in: 86_400, status: 'Success' });

    let manifestCalls = 0;
    const batchSizes: number[] = [];
    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .times(5)
      .reply(200, (_uri, body) => {
        manifestCalls += 1;
        const items = body as { orderNumber: string }[];
        batchSizes.push(items.length);
        return {
          status: 'Success',
          successResponse: items.map((item, index) => ({
            orderNumber: item.orderNumber,
            awbNumber: 200000010000 + manifestCalls * 100 + index,
            customerCode: 'UEBCUS0008',
          })),
          errorResponse: [],
        };
      });

    const submitted = await request(harness.app).post('/api/v1/orders/bulk').send({ orders });
    expect(submitted.body.data.accepted_count).toBe(20);

    const batch = await waitForBatch(submitted.body.data.batch_id);

    expect(batch.status).toBe('COMPLETED');
    // 20 orders at a max batch size of 15 is two manifest calls, not twenty.
    expect(manifestCalls).toBe(2);
    expect(batchSizes.sort((a, b) => b - a)).toEqual([15, 5]);

    const items = batch.items as { status: string; awb: string | null }[];
    expect(items).toHaveLength(20);
    expect(items.every((item) => item.status === 'SUCCEEDED' && item.awb !== null)).toBe(true);
  }, 40_000);

  it('reports per-order outcomes when the courier partially fails the chunk', async () => {
    const stamp = `PARTIAL-${Date.now()}`;
    const orders = Array.from({ length: 4 }, (_, index) =>
      orderPayload(`${stamp}-${index}`, 'urbanebolt'),
    );

    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/auth/getToken/')
      .times(5)
      .reply(200, { access_token: 't', expires_in: 86_400, status: 'Success' });

    nock(URBANEBOLT_BASE_URL)
      .post('/api/v1/services/manifest/')
      .reply(200, {
        status: 'Success',
        successResponse: [
          { orderNumber: `${stamp}-0`, awbNumber: 200000020001, customerCode: 'UEBCUS0008' },
          { orderNumber: `${stamp}-1`, awbNumber: 200000020002, customerCode: 'UEBCUS0008' },
        ],
        errorResponse: [
          { orderNumber: `${stamp}-2`, message: 'Consignee Pincode 999999 is not serviceable' },
          { orderNumber: `${stamp}-3`, message: 'orderNumber already shipped!' },
        ],
      });

    const submitted = await request(harness.app).post('/api/v1/orders/bulk').send({ orders });
    const batch = await waitForBatch(submitted.body.data.batch_id);

    expect(batch.status).toBe('COMPLETED_WITH_ERRORS');

    const items = batch.items as {
      order_id: string;
      status: string;
      error: { code: string } | null;
    }[];
    const byId = new Map(items.map((item) => [item.order_id, item]));

    expect(byId.get(`${stamp}-0`)?.status).toBe('SUCCEEDED');
    expect(byId.get(`${stamp}-2`)?.error?.code).toBe('PINCODE_NOT_SERVICEABLE');
    expect(byId.get(`${stamp}-3`)?.error?.code).toBe('DUPLICATE_AT_COURIER');

    const duplicate = await request(harness.app).get(`/api/v1/orders/${stamp}-3`);
    expect(duplicate.body.data.status).toBe('RECONCILIATION_REQUIRED');
  }, 40_000);

  it('falls back to one call per order for a courier without batch support', async () => {
    const stamp = `MOCK-${Date.now()}`;
    const orders = Array.from({ length: 3 }, (_, index) =>
      orderPayload(`${stamp}-${index}`, 'mock'),
    );

    const submitted = await request(harness.app).post('/api/v1/orders/bulk').send({ orders });
    const batch = await waitForBatch(submitted.body.data.batch_id);

    expect(batch.status).toBe('COMPLETED');
    const items = batch.items as { status: string; awb: string | null }[];
    expect(items.every((item) => item.status === 'SUCCEEDED')).toBe(true);
    expect(new Set(items.map((item) => item.awb)).size).toBe(3);
  }, 40_000);

  it('marks a repeated order_id as a duplicate rather than shipping it twice', async () => {
    const orderId = `REPEAT-${Date.now()}`;
    const first = await request(harness.app)
      .post('/api/v1/orders/bulk')
      .send({ orders: [orderPayload(orderId, 'mock')] });
    await waitForBatch(first.body.data.batch_id);

    const second = await request(harness.app)
      .post('/api/v1/orders/bulk')
      .send({ orders: [orderPayload(orderId, 'mock')] });
    const batch = await waitForBatch(second.body.data.batch_id);

    expect(second.body.data.accepted_count).toBe(0);
    const items = batch.items as { status: string }[];
    expect(items[0]?.status).toBe('DUPLICATE');
  }, 40_000);

  it('refuses a batch larger than the configured limit', async () => {
    const orders = Array.from({ length: 101 }, (_, index) =>
      orderPayload(`TOOBIG-${index}`, 'mock'),
    );

    const response = await request(harness.app).post('/api/v1/orders/bulk').send({ orders });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details[0].issue).toBe('too_many');
  });
});
