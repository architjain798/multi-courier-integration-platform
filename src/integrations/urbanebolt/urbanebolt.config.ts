import { z } from 'zod';
import { AppError, detailsFromZodError, ErrorCode } from '../../libraries/errors/index.js';

const schema = z.object({
  URBANEBOLT_BASE_URL: z.string().min(1),
  URBANEBOLT_USERNAME: z.string().min(1),
  URBANEBOLT_PASSWORD: z.string().min(1),
  URBANEBOLT_CUSTOMER_CODE: z.string().min(1),
  URBANEBOLT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  URBANEBOLT_RETRY_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  URBANEBOLT_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(500),
  URBANEBOLT_MAX_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(15),
});

export type UrbaneBoltConfig = {
  baseUrl: string;
  username: string;
  password: string;
  customerCode: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBackoffMs: number;
  maxBatchSize: number;
};

export function loadUrbaneBoltConfig(env: NodeJS.ProcessEnv): UrbaneBoltConfig {
  const source = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    throw new AppError(
      ErrorCode.COURIER_NOT_CONFIGURED,
      'UrbaneBolt is enabled but its configuration is incomplete',
      { isOperational: false, details: detailsFromZodError(parsed.error) },
    );
  }

  const values = parsed.data;
  return {
    baseUrl: values.URBANEBOLT_BASE_URL.replace(/\/+$/, ''),
    username: values.URBANEBOLT_USERNAME,
    password: values.URBANEBOLT_PASSWORD,
    customerCode: values.URBANEBOLT_CUSTOMER_CODE,
    timeoutMs: values.URBANEBOLT_TIMEOUT_MS,
    retryAttempts: values.URBANEBOLT_RETRY_ATTEMPTS,
    retryBackoffMs: values.URBANEBOLT_RETRY_BACKOFF_MS,
    maxBatchSize: values.URBANEBOLT_MAX_BATCH_SIZE,
  };
}
