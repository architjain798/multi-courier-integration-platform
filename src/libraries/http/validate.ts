import type { ZodType } from 'zod';
import { AppError, detailsFromZodError } from '../errors/index.js';

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw AppError.validation(
      'Request body failed validation',
      detailsFromZodError(parsed.error),
    );
  }
  return parsed.data;
}

export function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw AppError.validation(
      'Query parameters failed validation',
      detailsFromZodError(parsed.error),
    );
  }
  return parsed.data;
}
