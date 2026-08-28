import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

export function createDocsRouter(document: object): Router {
  const router = Router();

  router.get('/docs/openapi.json', (_req, res) => {
    res.json(document);
  });
  router.use('/docs', swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'Courier API' }));

  return router;
}
