import type { Job } from 'bullmq';
import type { ErrorHandler } from '../../../../libraries/errors/index.js';
import type { Logger } from '../../../../libraries/logger/index.js';
import { runWithContext } from '../../../../libraries/context/index.js';
import type { BulkChunkJob, BulkOrderService } from '../../domain/bulk-order.service.js';

export function createBulkChunkProcessor(
  bulkService: BulkOrderService,
  errorHandler: ErrorHandler,
  logger: Logger,
): (job: Job<BulkChunkJob>) => Promise<void> {
  return async (job) =>
    runWithContext(`job_${job.id ?? 'unknown'}`, async () => {
      logger.info(
        {
          batchId: job.data.batchId,
          courierPartner: job.data.courierPartner,
          orders: job.data.orderIds.length,
          attempt: job.attemptsMade + 1,
        },
        'Processing bulk chunk',
      );

      try {
        await bulkService.processChunk(job.data);
      } catch (error) {
        errorHandler.handle(error, {
          source: 'bulkChunkProcessor',
          batchId: job.data.batchId,
          courierPartner: job.data.courierPartner,
        });
        throw error;
      }
    });
}
