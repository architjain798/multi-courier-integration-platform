export type {
  CourierAdapter,
  CourierCapabilities,
  CourierDescriptor,
  CourierFactoryDependencies,
  BatchCreateOutcome,
} from './domain/courier.interface.js';
export { CourierRegistry, buildRegistry } from './domain/courier.registry.js';
export type { AdapterDecorator, CourierSummary } from './domain/courier.registry.js';
export {
  CourierError,
  isCourierError,
  auditOf,
  courierMessageOf,
} from './domain/courier.errors.js';
export type { CourierErrorOptions } from './domain/courier.errors.js';
export {
  ShipmentStatus,
  SHIPMENT_STATUSES,
  isTerminal,
  isCancellable,
} from './domain/shipment-status.js';
export {
  PaymentMode,
  PAYMENT_MODES,
  ServiceLevel,
  SERVICE_LEVELS,
  AddressType,
  ADDRESS_TYPES,
  CourierOperation,
  COURIER_OPERATIONS,
} from './domain/courier.types.js';
export type {
  Address,
  CancellationOutcome,
  CourierAudit,
  CourierResult,
  Invoice,
  NormalizedOrder,
  OrderItem,
  Parcel,
  ServiceabilityInfo,
  ShipmentCreated,
  TrackingScan,
  TrackingSnapshot,
} from './domain/courier.types.js';
export { createCouriersController } from './entry-points/api/couriers.controller.js';
export type { CouriersController } from './entry-points/api/couriers.controller.js';
export { createCouriersRouter } from './entry-points/api/couriers.routes.js';
