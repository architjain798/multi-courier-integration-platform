import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { AppError, ErrorCode } from '../../../libraries/errors/index.js';
import {
  bulkBatchItems,
  bulkBatches,
  type BatchItemStatus,
  type BulkBatchItemRow,
  type BulkBatchRow,
} from './schema.js';

export type BatchItemSeed = {
  orderId: string;
  courierPartner: string;
  status: BatchItemStatus;
  awb?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type BatchItemOutcome = {
  status: BatchItemStatus;
  awb?: string;
  errorCode?: string;
  errorMessage?: string;
};

export class BulkBatchRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    totalCount: number;
    acceptedCount: number;
    rejectedCount: number;
    items: readonly BatchItemSeed[];
  }): Promise<BulkBatchRow> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(bulkBatches)
        .values({
          totalCount: input.totalCount,
          acceptedCount: input.acceptedCount,
          rejectedCount: input.rejectedCount,
        })
        .returning();

      const batch = inserted[0];
      if (batch === undefined) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Batch insert returned no row', {
          isOperational: false,
        });
      }

      if (input.items.length > 0) {
        await tx.insert(bulkBatchItems).values(
          input.items.map((item) => ({
            batchId: batch.id,
            orderId: item.orderId,
            courierPartner: item.courierPartner,
            status: item.status,
            awb: item.awb ?? null,
            errorCode: item.errorCode ?? null,
            errorMessage: item.errorMessage ?? null,
          })),
        );
      }

      return batch;
    });
  }

  async findById(batchId: string): Promise<{ batch: BulkBatchRow; items: BulkBatchItemRow[] }> {
    const rows = await this.db
      .select()
      .from(bulkBatches)
      .where(eq(bulkBatches.id, batchId))
      .limit(1);
    const batch = rows[0];
    if (batch === undefined) {
      throw new AppError(ErrorCode.BATCH_NOT_FOUND, `No batch with id "${batchId}"`);
    }

    const items = await this.db
      .select()
      .from(bulkBatchItems)
      .where(eq(bulkBatchItems.batchId, batchId))
      .orderBy(asc(bulkBatchItems.createdAt));

    return { batch, items };
  }

  async recordOutcome(batchId: string, orderId: string, outcome: BatchItemOutcome): Promise<void> {
    await this.db
      .update(bulkBatchItems)
      .set({
        status: outcome.status,
        awb: outcome.awb ?? null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(bulkBatchItems.batchId, batchId), eq(bulkBatchItems.orderId, orderId)));
  }

  async refreshStatus(batchId: string): Promise<BulkBatchRow> {
    const [counts] = await this.db
      .select({
        pending: sql<number>`count(*) filter (where ${bulkBatchItems.status} = 'PENDING')::int`,
        failed: sql<number>`count(*) filter (where ${bulkBatchItems.status} = 'FAILED')::int`,
      })
      .from(bulkBatchItems)
      .where(eq(bulkBatchItems.batchId, batchId));

    if (counts === undefined || counts.pending > 0) {
      const rows = await this.db.select().from(bulkBatches).where(eq(bulkBatches.id, batchId));
      const batch = rows[0];
      if (batch === undefined) {
        throw new AppError(ErrorCode.BATCH_NOT_FOUND, `No batch with id "${batchId}"`);
      }
      return batch;
    }

    const updated = await this.db
      .update(bulkBatches)
      .set({
        status: counts.failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
        completedAt: new Date(),
      })
      .where(eq(bulkBatches.id, batchId))
      .returning();

    const batch = updated[0];
    if (batch === undefined) {
      throw new AppError(ErrorCode.BATCH_NOT_FOUND, `No batch with id "${batchId}"`);
    }
    return batch;
  }
}
