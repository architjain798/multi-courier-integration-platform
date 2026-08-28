import { setTimeout as sleep } from 'node:timers/promises';
import { setAttempt } from '../../../../libraries/context/index.js';
import { AppError, ErrorCode, isAppError } from '../../../../libraries/errors/index.js';
import type { Logger } from '../../../../libraries/logger/index.js';
import type {
  BatchCreateOutcome,
  CourierAdapter,
  CourierCapabilities,
} from '../courier.interface.js';
import {
  CourierOperation,
  type CancellationOutcome,
  type CourierResult,
  type NormalizedOrder,
  type ServiceabilityInfo,
  type ShipmentCreated,
  type TrackingSnapshot,
} from '../courier.types.js';

export type RetryOptions = {
  attempts: number;
  backoffMs: number;
  maxBackoffMs: number;
};

export class RetryingCourierAdapter implements CourierAdapter {
  constructor(
    private readonly inner: CourierAdapter,
    private readonly options: RetryOptions,
    private readonly logger: Logger,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get capabilities(): CourierCapabilities {
    return this.inner.capabilities;
  }

  createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>> {
    return this.run(CourierOperation.CREATE_SHIPMENT, () => this.inner.createShipment(order));
  }

  createShipments(orders: NormalizedOrder[]): Promise<CourierResult<BatchCreateOutcome[]>> {
    const batchCreate = this.inner.createShipments?.bind(this.inner);
    if (batchCreate === undefined) {
      return Promise.reject(unsupported(this.inner.id, 'batch create'));
    }
    return this.run(CourierOperation.CREATE_SHIPMENT, () => batchCreate(orders));
  }

  trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>> {
    return this.run(CourierOperation.TRACK_SHIPMENT, () => this.inner.trackShipment(awb));
  }

  cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>> {
    return this.run(CourierOperation.CANCEL_SHIPMENT, () => this.inner.cancelShipment(awb));
  }

  checkServiceability(pincodes: string[]): Promise<CourierResult<ServiceabilityInfo[]>> {
    const check = this.inner.checkServiceability?.bind(this.inner);
    if (check === undefined) {
      return Promise.reject(unsupported(this.inner.id, 'serviceability checks'));
    }
    return this.run(CourierOperation.CHECK_SERVICEABILITY, () => check(pincodes));
  }

  isAuthFailure(error: unknown): boolean {
    return this.inner.isAuthFailure(error);
  }

  invalidateAuth(): Promise<void> {
    return this.inner.invalidateAuth();
  }

  // The adapter decides what is retryable, because only it knows that an UrbaneBolt 200 carrying
  // status "Failed" is a permanent business error while a 502 is not.
  private async run<T>(operation: CourierOperation, call: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.options.attempts; attempt += 1) {
      setAttempt(attempt);
      try {
        return await call();
      } catch (error) {
        lastError = error;
        const retryable = isAppError(error) && error.retryable;
        if (!retryable || attempt === this.options.attempts) {
          throw error;
        }

        const delayMs = this.delayFor(attempt);
        this.logger.warn(
          { courier: this.inner.id, operation, attempt, delayMs, errorCode: error.code },
          'Courier call failed, retrying after backoff',
        );
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  private delayFor(attempt: number): number {
    const exponential = this.options.backoffMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, this.options.maxBackoffMs);
    return Math.round(capped * (0.5 + Math.random() * 0.5));
  }
}

function unsupported(courierId: string, operation: string): AppError {
  return new AppError(
    ErrorCode.OPERATION_NOT_SUPPORTED,
    `Courier "${courierId}" does not support ${operation}`,
  );
}
