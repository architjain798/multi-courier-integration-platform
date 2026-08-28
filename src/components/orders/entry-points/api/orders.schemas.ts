import {
  ADDRESS_TYPES,
  PAYMENT_MODES,
  SERVICE_LEVELS,
  SHIPMENT_STATUSES,
  type Address,
  type NormalizedOrder,
} from '../../../couriers/index.js';
import { openApiRegistry, z } from '../../../../libraries/openapi/registry.js';

const addressSchema = z
  .strictObject({
    name: z.string().min(1).max(120),
    phone: z.string().regex(/^\+?[\d\s-]{8,16}$/, 'must be a valid phone number'),
    email: z.email().optional(),
    line1: z.string().min(1).max(250),
    line2: z.string().max(250).optional(),
    city: z.string().min(1).max(80),
    state: z.string().min(1).max(80),
    pincode: z.string().regex(/^\d{6}$/, 'must be a six digit pincode'),
    country: z.string().min(1).max(60).default('India'),
    type: z.enum(ADDRESS_TYPES),
  })
  .openapi('Address');

const parcelSchema = z
  .strictObject({
    weight_kg: z.number().positive().max(1000),
    length_cm: z.number().positive().max(500),
    breadth_cm: z.number().positive().max(500),
    height_cm: z.number().positive().max(500),
    pieces: z.number().int().positive().max(100).default(1),
  })
  .openapi('Parcel');

const itemSchema = z
  .strictObject({
    description: z.string().min(1).max(200),
    quantity: z.number().int().positive(),
    sku: z.string().max(80).optional(),
    hsn: z.string().max(20).optional(),
  })
  .openapi('OrderItem');

export const exampleOrder = {
  courier_partner: 'urbanebolt',
  order_id: 'ORD-1001',
  payment_mode: 'COD',
  service_level: 'SAME_DAY',
  collectable_amount: 1499,
  declared_value: 1499,
  invoice: { number: 'INV-1', date: '2026-08-27', value: 1499 },
  pickup: {
    name: 'Warehouse',
    phone: '9425018023',
    line1: 'Plot 137 Sector-I',
    city: 'Gurgaon',
    state: 'Haryana',
    pincode: '122017',
    country: 'INDIA',
    type: 'SELLER',
  },
  delivery: {
    name: 'Priya Sharma',
    phone: '8320226438',
    line1: '26 Om Nagar',
    city: 'Gurgaon',
    state: 'Haryana',
    pincode: '122001',
    country: 'INDIA',
    type: 'HOME',
  },
  package: { weight_kg: 1.1, length_cm: 12, breadth_cm: 10, height_cm: 10, pieces: 1 },
  items: [{ description: 'Paperback books', quantity: 1 }],
};

// strictObject, not object: zod's default is to strip unknown keys, which would turn a typo like
// "collectible_amount" into a silent zero-value COD shipment instead of a 400.
export const createOrderSchema = z
  .strictObject({
    courier_partner: z.string().min(1),
    order_id: z.string().min(1).max(64),
    payment_mode: z.enum(PAYMENT_MODES),
    service_level: z.enum(SERVICE_LEVELS),
    collectable_amount: z.number().nonnegative().default(0),
    declared_value: z.number().positive(),
    invoice: z.strictObject({
      number: z.string().min(1).max(64),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)'),
      value: z.number().nonnegative(),
    }),
    pickup: addressSchema,
    delivery: addressSchema,
    return_address: addressSchema.optional(),
    package: parcelSchema,
    items: z.array(itemSchema).min(1).max(50),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((order) => order.payment_mode !== 'COD' || order.collectable_amount > 0, {
    path: ['collectable_amount'],
    error: 'must be greater than zero for a COD shipment',
  })
  .openapi('CreateOrderRequest', { example: exampleOrder });

export type CreateOrderRequest = z.infer<typeof createOrderSchema>;

// Items are deliberately unvalidated here. Validating the array with createOrderSchema would
// reject the whole batch over one bad order, and the contract promises per-order outcomes.
export const bulkCreateOrdersSchema = z
  .strictObject({
    orders: z.array(z.unknown()).min(1),
  })
  .openapi('BulkCreateOrdersRequest');

export const listOrdersQuerySchema = z.object({
  status: z
    .union([z.enum(SHIPMENT_STATUSES), z.array(z.enum(SHIPMENT_STATUSES))])
    .optional()
    .openapi({ example: 'FAILED' }),
  courier_partner: z.string().min(1).optional().openapi({ example: 'urbanebolt' }),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

openApiRegistry.register('CreateOrderRequest', createOrderSchema);
openApiRegistry.register('BulkCreateOrdersRequest', bulkCreateOrdersSchema);

export function toNormalizedOrder(request: CreateOrderRequest): NormalizedOrder {
  return {
    orderId: request.order_id,
    courierPartner: request.courier_partner,
    paymentMode: request.payment_mode,
    serviceLevel: request.service_level,
    collectableAmount: request.collectable_amount,
    declaredValue: request.declared_value,
    invoice: {
      number: request.invoice.number,
      date: request.invoice.date,
      value: request.invoice.value,
    },
    pickup: toAddress(request.pickup),
    delivery: toAddress(request.delivery),
    parcel: {
      weightKg: request.package.weight_kg,
      lengthCm: request.package.length_cm,
      breadthCm: request.package.breadth_cm,
      heightCm: request.package.height_cm,
      pieces: request.package.pieces,
    },
    items: request.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      ...(item.sku === undefined ? {} : { sku: item.sku }),
      ...(item.hsn === undefined ? {} : { hsn: item.hsn }),
    })),
    ...(request.return_address === undefined
      ? {}
      : { returnAddress: toAddress(request.return_address) }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  };
}

function toAddress(input: CreateOrderRequest['pickup']): Address {
  return {
    name: input.name,
    phone: input.phone,
    line1: input.line1,
    city: input.city,
    state: input.state,
    pincode: input.pincode,
    country: input.country,
    type: input.type,
    ...(input.email === undefined ? {} : { email: input.email }),
    ...(input.line2 === undefined ? {} : { line2: input.line2 }),
  };
}
