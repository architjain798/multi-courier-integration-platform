import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, ErrorCode, type ErrorHandler } from '../../errors/index.js';
import { failure } from '../envelope.js';

export function notFound(): RequestHandler {
  return (req, _res, next) => {
    next(new AppError(ErrorCode.ROUTE_NOT_FOUND, `No route matches ${req.method} ${req.path}`));
  };
}

export function errorMiddleware(
  errorHandler: ErrorHandler,
  exposeInternals: boolean,
): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const appError = errorHandler.handle(error, { method: req.method, path: req.path });
    res.status(appError.status).json(failure(appError, exposeInternals));
  };
}
