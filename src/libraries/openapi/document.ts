import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { openApiRegistry } from './registry.js';

// A server variable rather than a fixed URL: Swagger UI and the generated Postman collection both
// surface it as one editable value, so pointing either at a deployed instance is a single edit.
const servers = [
  {
    url: '{baseUrl}',
    variables: {
      baseUrl: {
        default: 'http://localhost:3000',
        description: 'Where this API is reachable',
      },
    },
  },
];

openApiRegistry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
});

export function buildOpenApiDocument(version: string): object {
  return new OpenApiGeneratorV31(openApiRegistry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      version,
      title: 'Multi-Courier Integration Platform',
      description:
        'Courier-agnostic shipping API. Callers pass a courier_partner and a normalized payload; ' +
        'the platform maps it to whichever courier is selected.',
    },
    servers,
  });
}
