import { z } from 'zod';
import { AppError, detailsFromZodError, ErrorCode } from '../errors/index.js';

function booleanFromEnv(fallback: 'true' | 'false') {
  return z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanFromEnv('false'),
  API_KEY: z.string().min(1).optional(),
  DEBUG_COURIER_ERRORS: booleanFromEnv('false'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  BULK_MAX_ORDERS: z.coerce.number().int().positive().max(1000).default(100),
  BULK_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  BULK_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  BULK_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  BULK_STALL_CHECK_MS: z.coerce.number().int().positive().default(15_000),

  TRACKING_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  WORKER_INLINE: booleanFromEnv('false'),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  logPretty: boolean;
  apiKey: string | undefined;
  debugCourierErrors: boolean;
  databaseUrl: string;
  redisUrl: string;
  bulk: {
    maxOrders: number;
    workerConcurrency: number;
    jobAttempts: number;
    backoffMs: number;
    stallCheckMs: number;
  };
  trackingTtlSeconds: number;
  workerInline: boolean;
};

// dotenv turns a bare `API_KEY=` into an empty string rather than leaving it unset, which would
// otherwise fail min-length checks instead of falling back to the default.
function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(withoutBlanks(source));
  if (!parsed.success) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'Invalid environment configuration', {
      isOperational: false,
      details: detailsFromZodError(parsed.error),
    });
  }

  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    apiKey: env.API_KEY,
    debugCourierErrors: env.DEBUG_COURIER_ERRORS,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    bulk: {
      maxOrders: env.BULK_MAX_ORDERS,
      workerConcurrency: env.BULK_WORKER_CONCURRENCY,
      jobAttempts: env.BULK_JOB_ATTEMPTS,
      backoffMs: env.BULK_BACKOFF_MS,
      stallCheckMs: env.BULK_STALL_CHECK_MS,
    },
    trackingTtlSeconds: env.TRACKING_TTL_SECONDS,
    workerInline: env.WORKER_INLINE,
  };
}
