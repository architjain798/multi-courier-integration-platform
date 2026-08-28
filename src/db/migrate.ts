import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../libraries/config/index.js';
import { createLogger } from '../libraries/logger/index.js';
import { createDatabase } from './client.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, pretty: config.logPretty });
const { db, pool } = createDatabase(config.databaseUrl, logger);

await migrate(db, { migrationsFolder: 'drizzle' });
logger.info('Migrations applied');
await pool.end();
