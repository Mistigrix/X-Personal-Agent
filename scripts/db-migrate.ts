/**
 * Applies pending database migrations. The agent also does this on every start;
 * this script is for maintenance (e.g. before restoring a backup).
 */
import { resolve } from 'node:path';
import { toDisplayPath } from '../src/config/load.ts';
import { migrateDatabase, openDatabase } from '../src/db/client.ts';
import { readEnvironment } from '../src/shared/dotenv.ts';

const root = resolve(import.meta.dirname, '..');
const env = readEnvironment(root);
const databasePath = resolve(root, env.DATABASE_PATH || './local/data/agent.db');

const handle = openDatabase(databasePath);
try {
  migrateDatabase(handle);
  console.log(`Database is up to date: ${toDisplayPath(root, databasePath)}`);
} finally {
  handle.close();
}
