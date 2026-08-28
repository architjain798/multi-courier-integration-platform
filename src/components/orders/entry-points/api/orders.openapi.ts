import { openApiRegistry, z } from '../../../../libraries/openapi/registry.js';
import { errorResponses, jsonResponse, secured } from '../../../../libraries/openapi/responses.js';
import {
  bulkCreateOrdersSchema,
  createOrderSchema,
  exampleOrder,
  listOrdersQuerySchema,
} from './orders.schemas.js';

const orderIdParam = z.object({
  orderId: z.string().openapi({ param: { name: 'orderId', in: 'path' }, example: 'ORD-1001' }),
});
const batchIdParam = z.object({
  batchId: z.string().openapi({
    param: { name: 'batchId', in: 'path' },
    example: '3f8f5b1a-1f2e-4d6b-9c0a-8b3c2d1e0f44',
  }),
});

openApiRegistry.registerPath({
  method: 'post',
  path: '/api/v1/orders',
  tags: ['Orders'],
  summary: 'Create a shipment with any courier',
  security: secured,
  request: { body: { content: { 'application/json': { schema: createOrderSchema } } } },
  responses: {
    201: jsonResponse('Shipment created'),
    200: jsonResponse('Idempotent replay of an order_id already submitted'),
    ...errorResponses,
  },
});

openApiRegistry.registerPath({
  method: 'post',
  path: '/api/v1/orders/bulk',
  tags: ['Orders'],
  summary: 'Submit up to 100 orders for background processing',
  security: secured,
  request: {
    body: {
      content: {
        'application/json': {
          schema: bulkCreateOrdersSchema,
          // The orders array is intentionally untyped, and a generator asked to invent a body from
          // that produces an empty array, which the endpoint rejects. Hence an explicit example:
          // one order that succeeds and one whose pincode no courier serves, so the first thing a
          // reader sees from a bulk run is the partial-success contract.
          example: {
            orders: [
              exampleOrder,
              {
                ...exampleOrder,
                order_id: 'ORD-1002',
                delivery: { ...exampleOrder.delivery, pincode: '999999' },
              },
            ],
          },
        },
      },
    },
  },
  responses: {
    202: jsonResponse('Batch accepted; poll status_url for per-order outcomes'),
    400: jsonResponse('The batch envelope itself was invalid'),
  },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/api/v1/orders',
  tags: ['Orders'],
  summary: 'List orders, optionally filtered by status or courier',
  security: secured,
  request: { query: listOrdersQuerySchema },
  responses: { 200: jsonResponse('Matching orders') },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/api/v1/orders/{orderId}',
  tags: ['Orders'],
  summary: 'Read a single order',
  security: secured,
  request: { params: orderIdParam },
  responses: { 200: jsonResponse('The order'), 404: errorResponses[404] },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/api/v1/orders/{orderId}/track',
  tags: ['Orders'],
  summary: 'Track a shipment and append any new courier scans',
  security: secured,
  request: { params: orderIdParam },
  responses: {
    200: jsonResponse('Current status plus append-only history'),
    404: errorResponses[404],
    409: errorResponses[409],
  },
});

openApiRegistry.registerPath({
  method: 'post',
  path: '/api/v1/orders/{orderId}/cancel',
  tags: ['Orders'],
  summary: 'Cancel a shipment before pickup',
  security: secured,
  request: { params: orderIdParam },
  responses: { 200: jsonResponse('Cancelled'), 409: errorResponses[409] },
});

openApiRegistry.registerPath({
  method: 'post',
  path: '/api/v1/orders/{orderId}/retry',
  tags: ['Orders'],
  summary: 'Re-drive a failed order through the same pipeline',
  security: secured,
  request: { params: orderIdParam },
  responses: { 200: jsonResponse('Retried'), 409: errorResponses[409] },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/api/v1/batches/{batchId}',
  tags: ['Orders'],
  summary: 'Per-order outcomes for a bulk submission',
  security: secured,
  request: { params: batchIdParam },
  responses: { 200: jsonResponse('Batch status'), 404: errorResponses[404] },
});
