import type { ShipmentStatus } from './shipment-status.js';

export const PAYMENT_MODES = ['PREPAID', 'COD'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PaymentMode = {
  PREPAID: 'PREPAID',
  COD: 'COD',
} as const satisfies Record<string, PaymentMode>;

export const SERVICE_LEVELS = ['SAME_DAY', 'NEXT_DAY', 'STANDARD'] as const;
export type ServiceLevel = (typeof SERVICE_LEVELS)[number];
export const ServiceLevel = {
  SAME_DAY: 'SAME_DAY',
  NEXT_DAY: 'NEXT_DAY',
  STANDARD: 'STANDARD',
} as const satisfies Record<string, ServiceLevel>;

export const ADDRESS_TYPES = ['HOME', 'OFFICE', 'SELLER', 'WAREHOUSE'] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];
export const AddressType = {
  HOME: 'HOME',
  OFFICE: 'OFFICE',
  SELLER: 'SELLER',
  WAREHOUSE: 'WAREHOUSE',
} as const satisfies Record<string, AddressType>;

export type Address = {
  name: string;
  phone: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  type: AddressType;
};

export type Parcel = {
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  pieces: number;
};

export type OrderItem = {
  description: string;
  quantity: number;
  sku?: string;
  hsn?: string;
};

export type Invoice = {
  number: string;
  date: string;
  value: number;
};

export type NormalizedOrder = {
  orderId: string;
  courierPartner: string;
  paymentMode: PaymentMode;
  serviceLevel: ServiceLevel;
  collectableAmount: number;
  declaredValue: number;
  invoice: Invoice;
  pickup: Address;
  delivery: Address;
  returnAddress?: Address;
  parcel: Parcel;
  items: OrderItem[];
  metadata?: Record<string, unknown>;
};

export type ShipmentCreated = {
  orderId: string;
  awb: string;
  courierOrderId?: string;
  labelUrl?: string;
  status: ShipmentStatus;
};

export type TrackingScan = {
  status: ShipmentStatus;
  courierStatusCode: string;
  courierStatusDescription?: string;
  reasonCode?: string;
  reasonDescription?: string;
  location?: string;
  eventTime: Date;
  raw: Record<string, unknown>;
};

export type TrackingSnapshot = {
  awb: string;
  status: ShipmentStatus;
  scans: TrackingScan[];
};

export type CancellationOutcome = {
  awb: string;
  message: string;
};

export type ServiceabilityInfo = {
  pincode: string;
  serviceable: boolean;
  inbound: boolean;
  outbound: boolean;
  serviceLevels: ServiceLevel[];
};

export const COURIER_OPERATIONS = [
  'AUTHENTICATE',
  'CREATE_SHIPMENT',
  'TRACK_SHIPMENT',
  'CANCEL_SHIPMENT',
  'CHECK_SERVICEABILITY',
] as const;
export type CourierOperation = (typeof COURIER_OPERATIONS)[number];
export const CourierOperation = {
  AUTHENTICATE: 'AUTHENTICATE',
  CREATE_SHIPMENT: 'CREATE_SHIPMENT',
  TRACK_SHIPMENT: 'TRACK_SHIPMENT',
  CANCEL_SHIPMENT: 'CANCEL_SHIPMENT',
  CHECK_SERVICEABILITY: 'CHECK_SERVICEABILITY',
} as const satisfies Record<string, CourierOperation>;

export type CourierAudit = {
  operation: CourierOperation;
  url: string;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
  durationMs: number;
};

export type CourierResult<T> = {
  value: T;
  audit: CourierAudit[];
};
