import type { Logger } from 'pino';
import { AppError, isAppError } from './app-error.js';
import { ErrorCode } from './error-codes.js';

export class ErrorHandler {
  constructor(private readonly logger: Logger) {}

  normalize(error: unknown): AppError {
    if (isAppError(error)) {
      return error;
    }
    const message = error instanceof Error ? error.message : 'Unexpected error';
    return new AppError(ErrorCode.INTERNAL_ERROR, message, {
      isOperational: false,
      cause: error,
    });
  }

  handle(error: unknown, context: Record<string, unknown> = {}): AppError {
    const normalized = this.normalize(error);
    const payload = {
      ...context,
      errorCode: normalized.code,
      courierPartner: normalized.courierPartner,
      err: normalized,
    };

    if (normalized.isOperational) {
      this.logger.warn(payload, normalized.message);
    } else {
      this.logger.error(payload, normalized.message);
    }
    return normalized;
  }
}
