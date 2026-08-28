import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../../errors/index.js';

export function apiKeyGuard(expected: string | undefined): RequestHandler {
  return (req, _res, next) => {
    if (expected === undefined) {
      next();
      return;
    }

    if (req.header('x-api-key') !== expected) {
      next(new AppError(ErrorCode.UNAUTHORIZED, 'Missing or invalid API key'));
      return;
    }

    next();
  };
}
