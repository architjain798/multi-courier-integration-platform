import type { Logger } from '../../../libraries/logger/index.js';
import type { CourierError } from './courier.errors.js';
import type {
  CancellationOutcome,
  CourierResult,
  NormalizedOrder,
  ServiceabilityInfo,
  ShipmentCreated,
  TrackingSnapshot,
} from './courier.types.js';

export type CourierCapabilities = {
  readonly supportsBatchCreate: boolean;
  readonly maxBatchSize: number;
  readonly supportsCancel: boolean;
  readonly supportsServiceability: boolean;
};

export type BatchCreateOutcome =
  | { orderId: string; ok: true; shipment: ShipmentCreated }
  | { orderId: string; ok: false; error: CourierError };

export interface CourierAdapter {
  readonly id: string;
  readonly capabilities: CourierCapabilities;

  createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>>;
  createShipments?(orders: NormalizedOrder[]): Promise<CourierResult<BatchCreateOutcome[]>>;
  trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>>;
  cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>>;
  checkServiceability?(pincodes: string[]): Promise<CourierResult<ServiceabilityInfo[]>>;

  isAuthFailure(error: unknown): boolean;
  invalidateAuth(): Promise<void>;
}

export type CourierFactoryDependencies = {
  logger: Logger;
};

export type CourierDescriptor = {
  readonly id: string;
  readonly displayName: string;
  isEnabled(env: NodeJS.ProcessEnv): boolean;
  create(env: NodeJS.ProcessEnv, deps: CourierFactoryDependencies): CourierAdapter;
};
