import type { ZodError } from 'zod';
import type { ErrorDetail } from './app-error.js';

export function detailsFromZodError(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : undefined,
    issue: issue.code,
    message: issue.message,
  }));
}
