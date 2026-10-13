/**
 * Exit code 0 if the agent's tick loop is alive (its lease is being renewed),
 * 1 otherwise. Used by the Docker HEALTHCHECK; usable from any monitor.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DEFAULT_DATABASE_PATH } from '../src/config/env.ts';
import { checkHealth } from '../src/services/health.ts';
import { readEnvironment } from '../src/shared/dotenv.ts';

const root = resolve(import.meta.dirname, '..');
const databasePath = resolve(root, readEnvironment(root).DATABASE_PATH || DEFAULT_DATABASE_PATH);
if (!existsSync(databasePath)) {
  console.error('Unhealthy: the database does not exist yet.');
  process.exit(1);
}
const sqlite = new Database(databasePath, { readonly: true });
try {
  const health = checkHealth(drizzle({ client: sqlite }), new Date());
  console.log(`${health.healthy ? 'Healthy' : 'Unhealthy'}: ${health.detail}`);
  process.exitCode = health.healthy ? 0 : 1;
} finally {
  sqlite.close();
}
