import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import type { TrackingScan } from '../../couriers/index.js';
import { trackingEvents, type TrackingEventRow } from './schema.js';

export class TrackingEventRepository {
  constructor(private readonly db: Database) {}

  async appendNew(orderRowId: string, scans: readonly TrackingScan[]): Promise<number> {
    if (scans.length === 0) {
      return 0;
    }

    const inserted = await this.db
      .insert(trackingEvents)
      .values(
        scans.map((scan) => ({
          orderId: orderRowId,
          status: scan.status,
          courierStatusCode: scan.courierStatusCode,
          courierStatusDescription: scan.courierStatusDescription ?? null,
          reasonCode: scan.reasonCode ?? null,
          reasonDescription: scan.reasonDescription ?? null,
          location: scan.location ?? null,
          eventTime: scan.eventTime,
          rawPayload: scan.raw,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: trackingEvents.id });

    return inserted.length;
  }

  listByOrder(orderRowId: string): Promise<TrackingEventRow[]> {
    return this.db
      .select()
      .from(trackingEvents)
      .where(eq(trackingEvents.orderId, orderRowId))
      .orderBy(asc(trackingEvents.eventTime));
  }
}
