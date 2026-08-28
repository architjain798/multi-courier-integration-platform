import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../../logger/index.js';

const QUIET_PATHS = ['/health', '/docs'];

// One line per request with method, path, status and duration. It stays at warn for a 5xx rather
// than error because the error itself is already logged, with its stack and courier context, by
// ErrorHandler — this line is the access record, not a second report of the same failure.
export function accessLog(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => QUIET_PATHS.some((path) => req.url.startsWith(path)),
    },
    customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'warn' : 'info'),
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  });
}
