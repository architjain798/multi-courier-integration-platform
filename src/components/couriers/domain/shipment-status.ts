export const SHIPMENT_STATUSES = [
  'PENDING',
  'CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'UNDELIVERED',
  'RTO',
  'CANCELLED',
  'FAILED',
  'RECONCILIATION_REQUIRED',
  'UNKNOWN',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const ShipmentStatus = {
  PENDING: 'PENDING',
  CREATED: 'CREATED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  UNDELIVERED: 'UNDELIVERED',
  RTO: 'RTO',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
  UNKNOWN: 'UNKNOWN',
} as const satisfies Record<string, ShipmentStatus>;

const TERMINAL: ReadonlySet<ShipmentStatus> = new Set([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.RTO,
]);

export function isTerminal(status: ShipmentStatus): boolean {
  return TERMINAL.has(status);
}

// UrbaneBolt only accepts cancellation before pickup, and the same holds for every courier
// we have looked at, so this lives in the shared domain rather than in an adapter.
export function isCancellable(status: ShipmentStatus): boolean {
  return status === ShipmentStatus.CREATED;
}
