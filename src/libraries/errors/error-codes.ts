export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_COURIER_PARTNER: 'UNKNOWN_COURIER_PARTNER',
  DUPLICATE_IN_REQUEST: 'DUPLICATE_IN_REQUEST',
  OPERATION_NOT_SUPPORTED: 'OPERATION_NOT_SUPPORTED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  SHIPMENT_ALREADY_CANCELLED: 'SHIPMENT_ALREADY_CANCELLED',
  DUPLICATE_AT_COURIER: 'DUPLICATE_AT_COURIER',
  SHIPMENT_NOT_CANCELLABLE: 'SHIPMENT_NOT_CANCELLABLE',
  SHIPMENT_NOT_TRACKABLE: 'SHIPMENT_NOT_TRACKABLE',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
  COURIER_VALIDATION_ERROR: 'COURIER_VALIDATION_ERROR',
  PINCODE_NOT_SERVICEABLE: 'PINCODE_NOT_SERVICEABLE',
  COURIER_RATE_LIMITED: 'COURIER_RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  COURIER_AUTH_ERROR: 'COURIER_AUTH_ERROR',
  COURIER_UNAVAILABLE: 'COURIER_UNAVAILABLE',
  COURIER_NOT_CONFIGURED: 'COURIER_NOT_CONFIGURED',
  COURIER_TIMEOUT: 'COURIER_TIMEOUT',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const httpStatusByCode: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNKNOWN_COURIER_PARTNER: 400,
  DUPLICATE_IN_REQUEST: 400,
  OPERATION_NOT_SUPPORTED: 400,
  UNAUTHORIZED: 401,
  ROUTE_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  BATCH_NOT_FOUND: 404,
  SHIPMENT_ALREADY_CANCELLED: 409,
  DUPLICATE_AT_COURIER: 409,
  SHIPMENT_NOT_CANCELLABLE: 409,
  SHIPMENT_NOT_TRACKABLE: 409,
  RECONCILIATION_REQUIRED: 409,
  COURIER_VALIDATION_ERROR: 422,
  PINCODE_NOT_SERVICEABLE: 422,
  COURIER_RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  COURIER_AUTH_ERROR: 502,
  COURIER_UNAVAILABLE: 502,
  COURIER_NOT_CONFIGURED: 503,
  COURIER_TIMEOUT: 504,
};

export function httpStatusFor(code: ErrorCode): number {
  return httpStatusByCode[code];
}

// Requirement 3.5 forbids leaking a courier's own wording to our callers. Any code listed here
// answers with our sentence instead; the courier's text is still persisted and logged. A
// CourierError may only carry a code from this map, so the substitution can never silently miss.
const clientMessages = {
  PINCODE_NOT_SERVICEABLE: 'The delivery pincode is not serviceable by this courier',
  DUPLICATE_AT_COURIER: 'The courier already holds a shipment for this order',
  SHIPMENT_ALREADY_CANCELLED: 'This shipment has already been cancelled',
  COURIER_VALIDATION_ERROR: 'The courier rejected the shipment details',
  COURIER_AUTH_ERROR: 'Authentication with the courier failed',
  COURIER_UNAVAILABLE: 'The courier service is currently unavailable',
  COURIER_TIMEOUT: 'The courier did not respond in time',
  COURIER_RATE_LIMITED: 'The courier rate limit has been reached',
  COURIER_NOT_CONFIGURED: 'This courier is not configured on this environment',
  ORDER_NOT_FOUND: 'The courier has no record of this shipment',
} as const satisfies Partial<Record<ErrorCode, string>>;

export type ClientFacingErrorCode = keyof typeof clientMessages;

export function clientMessageFor(code: ClientFacingErrorCode): string;
export function clientMessageFor(code: string): string | undefined;
export function clientMessageFor(code: string): string | undefined {
  const byName: Record<string, string | undefined> = clientMessages;
  return byName[code];
}
