import { z } from '../../../../libraries/openapi/registry.js';

export const serviceabilityQuerySchema = z.object({
  courier_partner: z.string().min(1).openapi({ example: 'urbanebolt' }),
  pincodes: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((entry) => entry.trim()))
    .pipe(z.array(z.string().regex(/^\d{6}$/)).min(1).max(50))
    .openapi({ example: '122001,122017' }),
});
