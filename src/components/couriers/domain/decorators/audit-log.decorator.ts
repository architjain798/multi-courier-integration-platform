import { getAttempt, getRequestId } from '../../../../libraries/context/index.js';
import { AppError, ErrorCode, isAppError } from '../../../../libraries/errors/index.js';
import type { Logger } from '../../../../libraries/logger/index.js';
import type { CourierApiLogRepository } from '../../data-access/courier-api-log.repository.js';
import { auditOf } from '../courier.errors.js';
import type { BatchCreateOutcome, CourierAdapter, CourierCapabilities } from '../courier.interface.js';
import type {
  CancellationOutcome,
  CourierAudit,
  CourierResult,
  NormalizedOrder,
  ServiceabilityInfo,
  ShipmentCreated,
  TrackingSnapshot,
} from '../courier.types.js';

export class AuditLoggingCourierAdapter implements CourierAdapter {
  constructor(
    private readonly inner: CourierAdapter,
    private readonly repository: CourierApiLogRepository,
    private readonly logger: Logger,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get capabilities(): CourierCapabilities {
    return this.inner.capabilities;
  }

  createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>> {
    return this.run(order.orderId, () => this.inner.createShipment(order));
  }

  createShipments(orders: NormalizedOrder[]): Promise<CourierResult<BatchCreateOutcome[]>> {
    const batchCreate = this.inner.createShipments?.bind(this.inner);
    if (batchCreate === undefined) {
      return Promise.reject(unsupportedBatch(this.inner.id));
    }
    const reference = orders.map((order) => order.orderId).join(',');
    return this.run(reference, () => batchCreate(orders));
  }

  trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>> {
    return this.run(awb, () => this.inner.trackShipment(awb));
  }

  cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>> {
    return this.run(awb, () => this.inner.cancelShipment(awb));
  }

  checkServiceability(pincodes: string[]): Promise<CourierResult<ServiceabilityInfo[]>> {
    const check = this.inner.checkServiceability?.bind(this.inner);
    if (check === undefined) {
      return Promise.reject(
        new AppError(
          ErrorCode.OPERATION_NOT_SUPPORTED,
          `Courier "${this.inner.id}" does not support serviceability checks`,
        ),
      );
    }
    return this.run(pincodes.join(','), () => check(pincodes));
  }

  isAuthFailure(error: unknown): boolean {
    return this.inner.isAuthFailure(error);
  }

  invalidateAuth(): Promise<void> {
    return this.inner.invalidateAuth();
  }

  private async run<T>(
    reference: string,
    call: () => Promise<CourierResult<T>>,
  ): Promise<CourierResult<T>> {
    try {
      const result = await call();
      await this.persist(result.audit, reference, null);
      return result;
    } catch (error) {
      await this.persist(auditOf(error), reference, isAppError(error) ? error.code : null);
      throw error;
    }
  }

  private async persist(
    audits: readonly CourierAudit[],
    reference: string,
    errorCode: string | null,
  ): Promise<void> {
    if (audits.length === 0) {
      return;
    }

    try {
      await this.repository.recordMany(audits, {
        courierPartner: this.inner.id,
        reference,
        requestId: getRequestId() ?? null,
        errorCode,
        attempt: getAttempt(),
      });
    } catch (error) {
      // Losing an audit row must never fail the shipment it describes, so this is logged and
      // dropped rather than rethrown.
      this.logger.error(
        { err: error, courier: this.inner.id, reference },
        'Failed to persist courier audit log',
      );
    }
  }
}

function unsupportedBatch(courierId: string): AppError {
  return new AppError(
    ErrorCode.OPERATION_NOT_SUPPORTED,
    `Courier "${courierId}" does not support batch create`,
  );
}
