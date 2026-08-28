import { z } from 'zod';
import { AppError, detailsFromZodError, ErrorCode } from '../../libraries/errors/index.js';
import type { MockCourierConfig } from './mock.adapter.js';

const schema = z.object({
  MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(0),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  MOCK_FORCE_ERROR: z
    .enum(['none', 'timeout', 'unavailable', 'auth', 'validation'])
    .default('none'),
});

export function loadMockCourierConfig(env: NodeJS.ProcessEnv): MockCourierConfig {
  const source = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    throw new AppError(
      ErrorCode.COURIER_NOT_CONFIGURED,
      'MockCourier is enabled but its configuration is invalid',
      { isOperational: false, details: detailsFromZodError(parsed.error) },
    );
  }

  return {
    latencyMs: parsed.data.MOCK_LATENCY_MS,
    failureRate: parsed.data.MOCK_FAILURE_RATE,
    forceError: parsed.data.MOCK_FORCE_ERROR,
  };
}
