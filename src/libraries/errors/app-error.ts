import { ErrorCode, httpStatusFor } from './error-codes.js';

export type ErrorDetail = Record<string, unknown>;

export type AppErrorOptions = {
  details?: ErrorDetail[];
  courierPartner?: string;
  retryable?: boolean;
  isOperational?: boolean;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[];
  readonly courierPartner: string | undefined;
  readonly retryable: boolean;
  readonly isOperational: boolean;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = httpStatusFor(code);
    this.details = options.details ?? [];
    this.courierPartner = options.courierPartner;
    this.retryable = options.retryable ?? false;
    this.isOperational = options.isOperational ?? true;
    Error.captureStackTrace(this, new.target);
  }

  static validation(message: string, details: ErrorDetail[]): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, { details });
  }

  static notFound(code: ErrorCode, message: string): AppError {
    return new AppError(code, message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
