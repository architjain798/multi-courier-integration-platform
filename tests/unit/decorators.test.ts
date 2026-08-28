import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { AuthRefreshingCourierAdapter } from '../../src/components/couriers/domain/decorators/auth-refresh.decorator.js';
import { RetryingCourierAdapter } from '../../src/components/couriers/domain/decorators/retry.decorator.js';
import type { NormalizedOrder } from '../../src/components/couriers/index.js';
import { ErrorCode } from '../../src/libraries/errors/index.js';
import {
  authError,
  permanentError,
  retryableError,
  StubCourierAdapter,
} from '../helpers/stub-adapter.js';

const silent = pino({ enabled: false });
const fastRetry = { attempts: 3, backoffMs: 1, maxBackoffMs: 2 };

const order = { orderId: 'ORD-1' } as unknown as NormalizedOrder;

describe('RetryingCourierAdapter', () => {
  it('retries a retryable failure and succeeds on a later attempt', async () => {
    const inner = new StubCourierAdapter((call) => (call < 3 ? retryableError() : 'ok'));
    const adapter = new RetryingCourierAdapter(inner, fastRetry, silent);

    const result = await adapter.createShipment(order);

    expect(inner.calls).toBe(3);
    expect(result.value.awb).toBe('AWB3');
  });

  it('gives up after the configured number of attempts and rethrows the last error', async () => {
    const inner = new StubCourierAdapter(() => retryableError());
    const adapter = new RetryingCourierAdapter(inner, fastRetry, silent);

    await expect(adapter.createShipment(order)).rejects.toMatchObject({
      code: ErrorCode.COURIER_UNAVAILABLE,
    });
    expect(inner.calls).toBe(3);
  });

  it('does not retry a permanent business failure', async () => {
    const inner = new StubCourierAdapter(() => permanentError());
    const adapter = new RetryingCourierAdapter(inner, fastRetry, silent);

    await expect(adapter.createShipment(order)).rejects.toMatchObject({
      code: ErrorCode.PINCODE_NOT_SERVICEABLE,
    });
    expect(inner.calls).toBe(1);
  });

  it('refuses batch create when the wrapped courier has no batch method', async () => {
    const adapter = new RetryingCourierAdapter(
      new StubCourierAdapter(() => 'ok'),
      fastRetry,
      silent,
    );

    await expect(adapter.createShipments([order])).rejects.toMatchObject({
      code: ErrorCode.OPERATION_NOT_SUPPORTED,
    });
  });
});

describe('AuthRefreshingCourierAdapter', () => {
  it('re-authenticates once and retries after an auth failure', async () => {
    const inner = new StubCourierAdapter((call) => (call === 1 ? authError() : 'ok'));
    const adapter = new AuthRefreshingCourierAdapter(inner, silent);

    const result = await adapter.createShipment(order);

    expect(inner.invalidations).toBe(1);
    expect(inner.calls).toBe(2);
    expect(result.value.awb).toBe('AWB2');
  });

  it('gives up if the retry also fails authentication', async () => {
    const inner = new StubCourierAdapter(() => authError());
    const adapter = new AuthRefreshingCourierAdapter(inner, silent);

    await expect(adapter.createShipment(order)).rejects.toMatchObject({
      code: ErrorCode.COURIER_AUTH_ERROR,
    });
    expect(inner.calls).toBe(2);
  });

  it('leaves a non-auth failure entirely alone', async () => {
    const inner = new StubCourierAdapter(() => permanentError());
    const adapter = new AuthRefreshingCourierAdapter(inner, silent);

    await expect(adapter.createShipment(order)).rejects.toMatchObject({
      code: ErrorCode.PINCODE_NOT_SERVICEABLE,
    });
    expect(inner.invalidations).toBe(0);
    expect(inner.calls).toBe(1);
  });
});

describe('the composed chain', () => {
  it('spends one re-auth without consuming a transport retry', async () => {
    const inner = new StubCourierAdapter((call) => {
      if (call === 1) return authError();
      if (call === 2) return retryableError();
      return 'ok';
    });
    const adapter = new RetryingCourierAdapter(
      new AuthRefreshingCourierAdapter(inner, silent),
      fastRetry,
      silent,
    );

    const result = await adapter.createShipment(order);

    expect(inner.invalidations).toBe(1);
    expect(result.value.awb).toBe('AWB3');
  });
});
