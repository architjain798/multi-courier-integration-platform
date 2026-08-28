import { z } from './registry.js';

export const secured = [{ ApiKeyAuth: [] }];

// Every route answers with the same envelope, so the response schema is deliberately shallow:
// the interesting shape is in `data`, which differs per route and is documented by the summaries.
export function jsonResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: z.looseObject({ success: z.boolean() }) } },
  };
}

export const errorResponses = {
  400: jsonResponse('Validation failed or the courier_partner is unknown'),
  404: jsonResponse('Order or batch not found'),
  409: jsonResponse('Shipment is in a state that forbids the operation'),
  422: jsonResponse('The courier rejected the shipment'),
  502: jsonResponse('The courier is unavailable or rejected our credentials'),
  504: jsonResponse('The courier timed out'),
};
