import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { pino } from 'pino';
import { createDatabase } from '../../src/db/client.js';

export type Infrastructure = {
  databaseUrl: string;
  redisUrl: string;
  stop: () => Promise<void>;
};

// CI runs everything through testcontainers so the suite is self-contained. Locally, pointing
// TEST_DATABASE_URL and TEST_REDIS_URL at `docker compose up` is faster and avoids the container
// runtime discovery problems that non-Docker-Desktop setups run into.
export async function startInfrastructure(): Promise<Infrastructure> {
  const existingDatabase = process.env.TEST_DATABASE_URL;
  const existingRedis = process.env.TEST_REDIS_URL;

  if (existingDatabase !== undefined && existingRedis !== undefined) {
    await applyMigrations(existingDatabase);
    return { databaseUrl: existingDatabase, redisUrl: existingRedis, stop: () => Promise.resolve() };
  }

  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  await applyMigrations(databaseUrl);

  return {
    databaseUrl,
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    stop: async () => {
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const { db, pool } = createDatabase(databaseUrl, pino({ enabled: false }));
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
  } finally {
    await pool.end();
  }
}
