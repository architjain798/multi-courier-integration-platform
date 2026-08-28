import { AppError, ErrorCode } from '../../../../libraries/errors/index.js';
import type { Logger } from '../../../../libraries/logger/index.js';
import type { BatchCreateOutcome, CourierAdapter, CourierCapabilities } from '../courier.interface.js';
import type {
  CancellationOutcome,
  CourierResult,
  NormalizedOrder,
  ServiceabilityInfo,
  ShipmentCreated,
  TrackingSnapshot,
} from '../courier.types.js';

export class AuthRefreshingCourierAdapter implements CourierAdapter {
  constructor(
    private readonly inner: CourierAdapter,
    private readonly logger: Logger,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get capabilities(): CourierCapabilities {
    return this.inner.capabilities;
  }

  createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>> {
    return this.run(() => this.inner.createShipment(order));
  }

  createShipments(orders: NormalizedOrder[]): Promise<CourierResult<BatchCreateOutcome[]>> {
    const batchCreate = this.inner.createShipments?.bind(this.inner);
    if (batchCreate === undefined) {
      return Promise.reject(unsupported(this.inner.id, 'batch create'));
    }
    return this.run(() => batchCreate(orders));
  }

  trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>> {
    return this.run(() => this.inner.trackShipment(awb));
  }

  cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>> {
    return this.run(() => this.inner.cancelShipment(awb));
  }

  checkServiceability(pincodes: string[]): Promise<CourierResult<ServiceabilityInfo[]>> {
    const check = this.inner.checkServiceability?.bind(this.inner);
    if (check === undefined) {
      return Promise.reject(unsupported(this.inner.id, 'serviceability checks'));
    }
    return this.run(() => check(pincodes));
  }

  isAuthFailure(error: unknown): boolean {
    return this.inner.isAuthFailure(error);
  }

  invalidateAuth(): Promise<void> {
    return this.inner.invalidateAuth();
  }

  private async run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!this.inner.isAuthFailure(error)) {
        throw error;
      }

      this.logger.warn(
        { courier: this.inner.id },
        'Courier rejected our credentials, re-authenticating and retrying once',
      );
      await this.inner.invalidateAuth();
      return await call();
    }
  }
}

function unsupported(courierId: string, operation: string): AppError {
  return new AppError(
    ErrorCode.OPERATION_NOT_SUPPORTED,
    `Courier "${courierId}" does not support ${operation}`,
  );
}
