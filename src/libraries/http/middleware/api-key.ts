import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../../errors/index.js';

export function apiKeyGuard(expected: string | undefined): RequestHandler {
  if (expected === undefined) {
    return (_req, _res, next) => {
      next();
    };
  }

  const digest = sha256(expected);

  return (req, _res, next) => {
    const presented = req.header('x-api-key');
    if (presented === undefined || !timingSafeEqual(digest, sha256(presented))) {
      next(new AppError(ErrorCode.UNAUTHORIZED, 'Missing or invalid API key'));
      return;
    }

    next();
  };
}

// A plain !== compares byte by byte and returns early, so response time leaks how much of the key a
// caller guessed. timingSafeEqual needs equal lengths and throws otherwise, which would leak the
// length instead; hashing both sides first makes every comparison the same fixed width.
function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
