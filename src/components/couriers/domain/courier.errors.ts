import {
  AppError,
  clientMessageFor,
  type AppErrorOptions,
  type ClientFacingErrorCode,
} from '../../../libraries/errors/index.js';
import type { CourierAudit } from './courier.types.js';

export type CourierErrorOptions = AppErrorOptions & {
  audit?: CourierAudit[];
};

export class CourierError extends AppError {
  readonly audit: CourierAudit[];
  readonly courierMessage: string;

  // courierMessage is whatever the courier said. `message` is our normalized wording, so the
  // envelope can never leak the courier's phrasing while the original stays available for logs,
  // the audit trail and the failure recorded on the order. The narrowed code type is what
  // guarantees our wording exists: a code with no client message will not compile here.
  constructor(
    code: ClientFacingErrorCode,
    courierMessage: string,
    options: CourierErrorOptions = {},
  ) {
    super(code, clientMessageFor(code), options);
    this.audit = options.audit ?? [];
    this.courierMessage = courierMessage;
  }
}

export function isCourierError(error: unknown): error is CourierError {
  return error instanceof CourierError;
}

export function auditOf(error: unknown): CourierAudit[] {
  return isCourierError(error) ? error.audit : [];
}

export function courierMessageOf(error: unknown): string | undefined {
  return isCourierError(error) ? error.courierMessage : undefined;
}
