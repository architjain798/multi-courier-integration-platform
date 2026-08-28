import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/libraries/errors/index.js';
import {
  businessError,
  codeForMessage,
  envelopeMessage,
  isAuthFailureResponse,
  isFailedEnvelope,
} from '../../src/integrations/urbanebolt/urbanebolt.errors.js';

describe('recognising failure inside a 200 response', () => {
  it('treats status Failed as a failure even though HTTP said OK', () => {
    expect(isFailedEnvelope({ status: 'Failed', message: 'Incorrect username/password!' })).toBe(
      true,
    );
  });

  it('does not treat a successful envelope as a failure', () => {
    expect(isFailedEnvelope({ status: 'Success', data: {} })).toBe(false);
    expect(isFailedEnvelope([])).toBe(false);
    expect(isFailedEnvelope(null)).toBe(false);
  });

  it('recognises the differently shaped auth failure body', () => {
    expect(isAuthFailureResponse(401, { detail: 'Authentication credentials were not provided.' }))
      .toBe(true);
    expect(isAuthFailureResponse(200, { detail: 'token expired' })).toBe(true);
    expect(isAuthFailureResponse(200, { status: 'Success' })).toBe(false);
  });

  it('reads the message from either message or detail', () => {
    expect(envelopeMessage({ message: 'Data Not Found' })).toBe('Data Not Found');
    expect(envelopeMessage({ detail: 'no credentials' })).toBe('no credentials');
    expect(envelopeMessage({})).toBe('UrbaneBolt rejected the request');
  });
});

describe('codeForMessage', () => {
  it.each([
    ['Consignee Pincode 999999 is not serviceable', ErrorCode.PINCODE_NOT_SERVICEABLE],
    ['orderNumber already shipped!', ErrorCode.DUPLICATE_AT_COURIER],
    ['Shipment already cancelled!', ErrorCode.SHIPMENT_ALREADY_CANCELLED],
    ['Requested AWB not found or may be not belong to your account', ErrorCode.ORDER_NOT_FOUND],
    ['Incorrect username/password!', ErrorCode.COURIER_AUTH_ERROR],
    ["'shprName' is a required property", ErrorCode.COURIER_VALIDATION_ERROR],
  ])('maps %s', (message, expected) => {
    expect(codeForMessage(message)).toBe(expected);
  });
});

describe('businessError', () => {
  it('keeps the courier wording internally but never puts it in the client message', () => {
    const error = businessError('Consignee Pincode 999999 is not serviceable', []);

    expect(error.code).toBe(ErrorCode.PINCODE_NOT_SERVICEABLE);
    expect(error.courierMessage).toBe('Consignee Pincode 999999 is not serviceable');
    expect(error.message).not.toContain('999999');
    expect(error.message).toBe('The delivery pincode is not serviceable by this courier');
  });

  it('marks business failures as not retryable', () => {
    expect(businessError('orderNumber already shipped!', []).retryable).toBe(false);
  });
});
