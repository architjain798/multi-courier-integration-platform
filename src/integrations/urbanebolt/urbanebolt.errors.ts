import { CourierError, type CourierAudit } from '../../components/couriers/index.js';
import { ErrorCode, type ClientFacingErrorCode } from '../../libraries/errors/index.js';

export const COURIER_ID = 'urbanebolt';

// UrbaneBolt answers 200 OK for business failures. A bad pincode, a duplicate order number and a
// validation error all arrive as HTTP 200 with `status: "Failed"` or a populated errorResponse[].
// The only genuine HTTP status it uses for a semantic problem is 401 for a dead token, and that
// response has a different body shape again ({"detail": ...}). Everything downstream of this file
// gets to assume a thrown CourierError means failure and a returned value means success.
export function isAuthFailureResponse(status: number, body: unknown): boolean {
  if (status === 401 || status === 403) {
    return true;
  }
  return isRecord(body) && typeof body.detail === 'string';
}

export function isFailedEnvelope(body: unknown): boolean {
  return isRecord(body) && body.status === 'Failed';
}

export function envelopeMessage(body: unknown): string {
  if (isRecord(body)) {
    const message = body.message ?? body.detail;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return 'UrbaneBolt rejected the request';
}

export function codeForMessage(message: string): ClientFacingErrorCode {
  const text = message.toLowerCase();

  if (text.includes('not serviceable')) {
    return ErrorCode.PINCODE_NOT_SERVICEABLE;
  }
  if (text.includes('already shipped')) {
    return ErrorCode.DUPLICATE_AT_COURIER;
  }
  if (text.includes('already cancelled')) {
    return ErrorCode.SHIPMENT_ALREADY_CANCELLED;
  }
  if (text.includes('not found') || text.includes('not belong to your account')) {
    return ErrorCode.ORDER_NOT_FOUND;
  }
  if (text.includes('incorrect username') || text.includes('password')) {
    return ErrorCode.COURIER_AUTH_ERROR;
  }
  return ErrorCode.COURIER_VALIDATION_ERROR;
}

export function businessError(message: string, audit: CourierAudit[]): CourierError {
  return new CourierError(codeForMessage(message), message, {
    courierPartner: COURIER_ID,
    audit,
    retryable: false,
  });
}

export function authError(message: string, audit: CourierAudit[]): CourierError {
  return new CourierError(ErrorCode.COURIER_AUTH_ERROR, message, {
    courierPartner: COURIER_ID,
    audit,
    retryable: false,
  });
}

export function transportError(
  code: ClientFacingErrorCode,
  message: string,
  audit: CourierAudit[],
): CourierError {
  return new CourierError(code, message, {
    courierPartner: COURIER_ID,
    audit,
    retryable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
