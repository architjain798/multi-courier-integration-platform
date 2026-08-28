import type { Database } from '../../../db/client.js';
import type { CourierAudit } from '../domain/courier.types.js';
import { courierApiLogs } from './schema.js';

export type AuditContext = {
  courierPartner: string;
  reference: string | null;
  requestId: string | null;
  errorCode: string | null;
  attempt: number;
};

export class CourierApiLogRepository {
  constructor(private readonly db: Database) {}

  async recordMany(audits: readonly CourierAudit[], context: AuditContext): Promise<void> {
    if (audits.length === 0) {
      return;
    }

    await this.db.insert(courierApiLogs).values(
      audits.map((audit) => ({
        courierPartner: context.courierPartner,
        operation: audit.operation,
        reference: context.reference,
        requestId: context.requestId,
        url: audit.url,
        requestBody: audit.requestBody,
        responseStatus: audit.responseStatus,
        responseBody: audit.responseBody,
        durationMs: audit.durationMs,
        attempt: context.attempt,
        errorCode: context.errorCode,
      })),
    );
  }
}
