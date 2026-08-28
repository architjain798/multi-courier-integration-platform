import type { ErrorRequestHandler } from 'express';
import { AppError, ErrorCode } from '../../errors/index.js';

type BodyParserError = Error & { type: string; status: number };

// express.json() rejects a body by throwing, and its error carries a `type` rather than anything
// this codebase understands. Left alone it reaches the error middleware as an unrecognised Error,
// so a client sending a stray comma gets a 500 logged as a programmer fault. Translating here, next
// to the parser that raised it, keeps that knowledge out of the generic handler.
export function bodyErrors(limit: string): ErrorRequestHandler {
  const failures: Record<string, { code: ErrorCode; message: string } | undefined> = {
    'entity.parse.failed': {
      code: ErrorCode.MALFORMED_JSON,
      message: 'The request body is not valid JSON',
    },
    'entity.too.large': {
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      message: `The request body is larger than the ${limit} limit`,
    },
    'encoding.unsupported': {
      code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      message: 'The request body uses an unsupported content encoding',
    },
    'request.aborted': {
      code: ErrorCode.MALFORMED_JSON,
      message: 'The request body was not fully received',
    },
  };

  return (error, _req, _res, next) => {
    const failure = isBodyParserError(error) ? failures[error.type] : undefined;
    next(
      failure === undefined ? error : new AppError(failure.code, failure.message, { cause: error }),
    );
  };
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    error instanceof Error &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number'
  );
}
