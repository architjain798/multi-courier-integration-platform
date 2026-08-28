import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode, ErrorHandler } from '../../src/libraries/errors/index.js';
import { failure } from '../../src/libraries/http/envelope.js';

function handler(): ErrorHandler {
  return new ErrorHandler(pino({ enabled: false }));
}

describe('ErrorHandler', () => {
  it('passes an AppError through untouched', () => {
    const original = new AppError(ErrorCode.PINCODE_NOT_SERVICEABLE, 'not serviceable', {
      courierPartner: 'urbanebolt',
    });

    expect(handler().normalize(original)).toBe(original);
  });

  it('treats an unknown throwable as a non-operational internal error', () => {
    const normalized = handler().normalize(new TypeError('cannot read x of undefined'));

    expect(normalized.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(normalized.status).toBe(500);
    expect(normalized.isOperational).toBe(false);
    expect(normalized.cause).toBeInstanceOf(TypeError);
  });

  it('normalizes values that are not Errors at all', () => {
    const normalized = handler().normalize('something went wrong');

    expect(normalized.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(normalized.isOperational).toBe(false);
  });
});

describe('failure envelope', () => {
  it('keeps the message of an operational error', () => {
    const envelope = failure(
      new AppError(ErrorCode.PINCODE_NOT_SERVICEABLE, 'Delivery pincode is not serviceable', {
        courierPartner: 'urbanebolt',
      }),
    );

    expect(envelope.error.message).toBe('Delivery pincode is not serviceable');
    expect(envelope.error.courier_partner).toBe('urbanebolt');
    expect(envelope.success).toBe(false);
  });

  it('hides the message of a programmer error from the client', () => {
    const internal = handler().normalize(new TypeError('orders[0].awb is undefined'));
    const envelope = failure(internal);

    expect(envelope.error.message).toBe('An unexpected error occurred');
    expect(envelope.error.message).not.toContain('awb');
  });

  it('exposes the underlying message only when explicitly asked to', () => {
    const internal = handler().normalize(new TypeError('orders[0].awb is undefined'));

    expect(failure(internal, true).error.message).toContain('awb');
  });
});
