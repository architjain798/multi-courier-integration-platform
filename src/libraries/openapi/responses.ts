import { z } from './registry.js';

export const secured = [{ ApiKeyAuth: [] }];

// Every route answers with the same envelope, so the response schema is deliberately shallow:
// the interesting shape is in `data`, which differs per route and is documented by the summaries.
// `success` is a literal rather than a boolean because a generator asked for an example of
// z.boolean() picks one at random, which produced committed examples showing a 201 Created next to
// {"success": false}.
function envelope(description: string, success: boolean) {
  return {
    description,
    content: { 'application/json': { schema: z.looseObject({ success: z.literal(success) }) } },
  };
}

export function jsonResponse(description: string) {
  return envelope(description, true);
}

export const errorResponses = {
  400: envelope(
    'Validation failed, the body is not JSON, or the courier_partner is unknown',
    false,
  ),
  404: envelope('Order or batch not found', false),
  409: envelope('Shipment is in a state that forbids the operation', false),
  413: envelope('The request body is larger than the configured limit', false),
  422: envelope('The courier rejected the shipment', false),
  502: envelope('The courier is unavailable or rejected our credentials', false),
  504: envelope('The courier timed out', false),
};
