import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from '../libraries/logger/index.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export type DatabaseHandle = {
  db: Database;
  pool: Pool;
};

export function createDatabase(connectionString: string, logger: Logger): DatabaseHandle {
  const pool = new Pool({ connectionString, max: 10 });

  // An idle client whose server went away emits 'error' on the pool. Unlistened, that becomes an
  // uncaught exception and kills the process over a recoverable blip.
  pool.on('error', (error: Error) => {
    logger.warn({ err: error, component: 'postgres' }, 'Idle Postgres client error');
  });

  return { db: drizzle(pool, { schema }), pool };
}
