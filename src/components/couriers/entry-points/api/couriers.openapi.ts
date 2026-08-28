import { openApiRegistry } from '../../../../libraries/openapi/registry.js';
import { errorResponses, jsonResponse, secured } from '../../../../libraries/openapi/responses.js';
import { serviceabilityQuerySchema } from './couriers.schemas.js';

openApiRegistry.registerPath({
  method: 'get',
  path: '/api/v1/couriers',
  tags: ['Couriers'],
  summary: 'Supported couriers and their capabilities',
  security: secured,
  responses: { 200: jsonResponse('Registered couriers') },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/api/v1/serviceability',
  tags: ['Couriers'],
  summary: 'Check whether a courier serves the given pincodes',
  security: secured,
  request: { query: serviceabilityQuerySchema },
  responses: { 200: jsonResponse('Serviceability per pincode'), 400: errorResponses[400] },
});
