import { setTimeout as sleep } from 'node:timers/promises';
import {
  CourierError,
  CourierOperation,
  ShipmentStatus,
  type CancellationOutcome,
  type CourierAdapter,
  type CourierAudit,
  type CourierCapabilities,
  type CourierResult,
  type NormalizedOrder,
  type ShipmentCreated,
  type TrackingSnapshot,
} from '../../components/couriers/index.js';
import { ErrorCode, isAppError } from '../../libraries/errors/index.js';

export const MOCK_COURIER_ID = 'mock';

export type MockCourierConfig = {
  latencyMs: number;
  failureRate: number;
  forceError: 'none' | 'timeout' | 'unavailable' | 'auth' | 'validation';
};

type Shipment = {
  orderId: string;
  awb: string;
  status: ShipmentStatus;
  createdAt: Date;
};

export class MockCourierAdapter implements CourierAdapter {
  readonly id = MOCK_COURIER_ID;
  readonly capabilities: CourierCapabilities = {
    supportsBatchCreate: false,
    maxBatchSize: 1,
    supportsCancel: true,
    supportsServiceability: false,
  };

  private readonly shipments = new Map<string, Shipment>();
  private nextAwb = 900_000_000_001;
  private authValid = true;

  constructor(private readonly config: MockCourierConfig) {}

  async createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>> {
    const audit = await this.simulate(CourierOperation.CREATE_SHIPMENT, order.orderId, order);

    const existing = this.shipments.get(order.orderId);
    if (existing !== undefined) {
      throw new CourierError(ErrorCode.DUPLICATE_AT_COURIER, 'orderNumber already shipped', {
        courierPartner: this.id,
        audit,
      });
    }

    const awb = String(this.nextAwb++);
    this.shipments.set(order.orderId, {
      orderId: order.orderId,
      awb,
      status: ShipmentStatus.CREATED,
      createdAt: new Date(),
    });

    return {
      value: { orderId: order.orderId, awb, status: ShipmentStatus.CREATED },
      audit,
    };
  }

  async trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>> {
    const audit = await this.simulate(CourierOperation.TRACK_SHIPMENT, awb, { awb });
    const shipment = this.findByAwb(awb, audit);

    return {
      value: {
        awb,
        status: shipment.status,
        scans: [
          {
            status: shipment.status,
            courierStatusCode: shipment.status,
            eventTime: shipment.createdAt,
            raw: { awb, status: shipment.status },
          },
        ],
      },
      audit,
    };
  }

  async cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>> {
    const audit = await this.simulate(CourierOperation.CANCEL_SHIPMENT, awb, { awb });
    const shipment = this.findByAwb(awb, audit);

    if (shipment.status === ShipmentStatus.CANCELLED) {
      throw new CourierError(ErrorCode.SHIPMENT_ALREADY_CANCELLED, 'Shipment already cancelled', {
        courierPartner: this.id,
        audit,
      });
    }

    shipment.status = ShipmentStatus.CANCELLED;
    return { value: { awb, message: 'Cancelled' }, audit };
  }

  isAuthFailure(error: unknown): boolean {
    return isAppError(error) && error.code === ErrorCode.COURIER_AUTH_ERROR;
  }

  invalidateAuth(): Promise<void> {
    this.authValid = true;
    return Promise.resolve();
  }

  private findByAwb(awb: string, audit: CourierAudit[]): Shipment {
    for (const shipment of this.shipments.values()) {
      if (shipment.awb === awb) {
        return shipment;
      }
    }
    throw new CourierError(ErrorCode.ORDER_NOT_FOUND, `No shipment with awb "${awb}"`, {
      courierPartner: this.id,
      audit,
    });
  }

  private async simulate(
    operation: CourierOperation,
    reference: string,
    requestBody: unknown,
  ): Promise<CourierAudit[]> {
    if (this.config.latencyMs > 0) {
      await sleep(this.config.latencyMs);
    }

    const injected = this.injectedFailure();
    const entry: CourierAudit = {
      operation,
      url: `mock://${this.id}/${operation.toLowerCase()}/${reference}`,
      requestBody,
      responseStatus: injected?.status ?? 200,
      responseBody: injected?.body ?? { simulated: true },
      durationMs: this.config.latencyMs,
    };

    if (injected !== null) {
      throw injected.error([entry]);
    }

    return [entry];
  }

  private injectedFailure(): {
    status: number;
    body: unknown;
    error: (audit: CourierAudit[]) => CourierError;
  } | null {
    const forced = this.config.forceError;
    const random = this.config.failureRate > 0 && Math.random() < this.config.failureRate;

    if (forced === 'timeout') {
      return {
        status: 0,
        body: { error: 'simulated timeout' },
        error: (audit) =>
          new CourierError(ErrorCode.COURIER_TIMEOUT, 'Simulated courier timeout', {
            courierPartner: this.id,
            audit,
            retryable: true,
          }),
      };
    }
    if (forced === 'auth' || !this.authValid) {
      this.authValid = false;
      return {
        status: 401,
        body: { detail: 'simulated expired token' },
        error: (audit) =>
          new CourierError(ErrorCode.COURIER_AUTH_ERROR, 'Simulated expired token', {
            courierPartner: this.id,
            audit,
          }),
      };
    }
    if (forced === 'validation') {
      return {
        status: 200,
        body: { status: 'Failed', message: 'simulated validation failure' },
        error: (audit) =>
          new CourierError(ErrorCode.COURIER_VALIDATION_ERROR, 'Simulated validation failure', {
            courierPartner: this.id,
            audit,
          }),
      };
    }
    if (forced === 'unavailable' || random) {
      return {
        status: 502,
        body: { error: 'simulated upstream failure' },
        error: (audit) =>
          new CourierError(ErrorCode.COURIER_UNAVAILABLE, 'Simulated courier outage', {
            courierPartner: this.id,
            audit,
            retryable: true,
          }),
      };
    }
    return null;
  }
}
