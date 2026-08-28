import { pino, type Logger } from 'pino';
import { getRequestId } from '../context/index.js';

export type { Logger };

export type LoggerOptions = {
  level: string;
  pretty: boolean;
};

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    mixin() {
      const requestId = getRequestId();
      return requestId === undefined ? {} : { requestId };
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        '*.password',
        '*.access_token',
        'requestBody.password',
        'responseBody.access_token',
      ],
      censor: '[redacted]',
    },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
}
