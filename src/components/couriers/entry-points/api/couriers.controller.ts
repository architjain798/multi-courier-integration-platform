import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../../../../libraries/errors/index.js';
import { success } from '../../../../libraries/http/envelope.js';
import { parseQuery } from '../../../../libraries/http/validate.js';
import type { CourierRegistry } from '../../domain/courier.registry.js';
import { serviceabilityQuerySchema } from './couriers.schemas.js';

export type CouriersController = {
  list: RequestHandler;
  serviceability: RequestHandler;
};

export function createCouriersController(registry: CourierRegistry): CouriersController {
  return {
    list(_req, res) {
      res.json(
        success({
          couriers: registry.list().map((courier) => ({
            id: courier.id,
            display_name: courier.displayName,
            capabilities: {
              supports_batch_create: courier.capabilities.supportsBatchCreate,
              max_batch_size: courier.capabilities.maxBatchSize,
              supports_cancel: courier.capabilities.supportsCancel,
              supports_serviceability: courier.capabilities.supportsServiceability,
            },
          })),
        }),
      );
    },

    async serviceability(req, res) {
      const query = parseQuery(serviceabilityQuerySchema, req.query);
      const adapter = registry.get(query.courier_partner);
      const check = adapter.checkServiceability?.bind(adapter);

      if (check === undefined || !adapter.capabilities.supportsServiceability) {
        throw new AppError(
          ErrorCode.OPERATION_NOT_SUPPORTED,
          `Courier "${query.courier_partner}" does not support serviceability checks`,
        );
      }

      const result = await check(query.pincodes);
      res.json(
        success({
          courier_partner: query.courier_partner,
          pincodes: result.value.map((entry) => ({
            pincode: entry.pincode,
            serviceable: entry.serviceable,
            inbound: entry.inbound,
            outbound: entry.outbound,
            service_levels: entry.serviceLevels,
          })),
        }),
      );
    },
  };
}
