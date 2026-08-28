import { getRequestId } from '../context/index.js';
import { isCourierError } from '../../components/couriers/index.js';
import type { AppError, ErrorDetail } from '../errors/index.js';

export type SuccessEnvelope<T> = {
  success: true;
  data: T;
  request_id: string;
};

export type ErrorEnvelope = {
  success: false;
  error: {
    code: string;
    message: string;
    details: ErrorDetail[];
    courier_partner: string | undefined;
    retryable: boolean;
  };
  request_id: string;
};

export function success<T>(data: T): SuccessEnvelope<T> {
  return { success: true, data, request_id: getRequestId() ?? 'unknown' };
}

function clientMessageOf(error: AppError, exposeInternals: boolean): string {
  if (!error.isOperational) {
    return exposeInternals ? error.message : 'An unexpected error occurred';
  }
  if (exposeInternals && isCourierError(error)) {
    return `${error.message} (courier said: ${error.courierMessage})`;
  }
  return error.message;
}

export function failure(error: AppError, exposeInternals = false): ErrorEnvelope {
  const clientMessage = clientMessageOf(error, exposeInternals);

  return {
    success: false,
    error: {
      code: error.code,
      message: clientMessage,
      details: error.details,
      courier_partner: error.courierPartner,
      retryable: error.retryable,
    },
    request_id: getRequestId() ?? 'unknown',
  };
}
