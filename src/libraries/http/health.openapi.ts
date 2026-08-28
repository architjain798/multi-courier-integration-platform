import { openApiRegistry } from '../openapi/registry.js';
import { jsonResponse } from '../openapi/responses.js';

openApiRegistry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['Operations'],
  summary: 'Liveness probe - answers whenever the process is up',
  responses: { 200: jsonResponse('Process is alive') },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/health/ready',
  tags: ['Operations'],
  summary: 'Readiness probe - checks Postgres, Redis and the courier registry',
  responses: {
    200: jsonResponse('Every dependency is reachable'),
    503: jsonResponse('At least one dependency is down; the body names which'),
  },
});
