import {
  CourierError,
  CourierOperation,
  ShipmentStatus,
  type CourierAdapter,
  type CourierAudit,
  type CourierCapabilities,
  type CourierResult,
  type NormalizedOrder,
  type CancellationOutcome,
  type TrackingSnapshot,
} from '../../src/components/couriers/index.js';
import { ErrorCode, isAppError } from '../../src/libraries/errors/index.js';

export function auditEntry(): CourierAudit {
  return {
    operation: CourierOperation.CREATE_SHIPMENT,
    url: 'stub://create',
    requestBody: null,
    responseStatus: 200,
    responseBody: null,
    durationMs: 1,
  };
}

export class StubCourierAdapter implements CourierAdapter {
  readonly id = 'stub';
  readonly capabilities: CourierCapabilities = {
    supportsBatchCreate: false,
    maxBatchSize: 1,
    supportsCancel: true,
    supportsServiceability: false,
  };

  calls = 0;
  invalidations = 0;

  constructor(private readonly script: (call: number) => 'ok' | CourierError) {}

  createShipment(order: NormalizedOrder): Promise<CourierResult<{ orderId: string; awb: string; status: ShipmentStatus }>> {
    this.calls += 1;
    const outcome = this.script(this.calls);
    if (outcome !== 'ok') {
      return Promise.reject(outcome);
    }
    return Promise.resolve({
      value: { orderId: order.orderId, awb: `AWB${this.calls}`, status: ShipmentStatus.CREATED },
      audit: [auditEntry()],
    });
  }

  trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>> {
    this.calls += 1;
    const outcome = this.script(this.calls);
    if (outcome !== 'ok') {
      return Promise.reject(outcome);
    }
    return Promise.resolve({
      value: { awb, status: ShipmentStatus.IN_TRANSIT, scans: [] },
      audit: [auditEntry()],
    });
  }

  cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>> {
    this.calls += 1;
    return Promise.resolve({ value: { awb, message: 'Cancelled' }, audit: [auditEntry()] });
  }

  isAuthFailure(error: unknown): boolean {
    return isAppError(error) && error.code === ErrorCode.COURIER_AUTH_ERROR;
  }

  invalidateAuth(): Promise<void> {
    this.invalidations += 1;
    return Promise.resolve();
  }
}

export function retryableError(): CourierError {
  return new CourierError(ErrorCode.COURIER_UNAVAILABLE, 'upstream down', { retryable: true });
}

export function permanentError(): CourierError {
  return new CourierError(ErrorCode.PINCODE_NOT_SERVICEABLE, 'pincode 999999 is not serviceable');
}

export function authError(): CourierError {
  return new CourierError(ErrorCode.COURIER_AUTH_ERROR, 'token expired');
}
