import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.ts';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

/** The database or a transaction: repository functions accept either. */
export type DbExecutor = BaseSQLiteDatabase<'sync', Database.RunResult, typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  sqlite: Database.Database;
  close(): void;
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Opens (creating if needed) the SQLite database. Use `:memory:` in tests. */
export function openDatabase(filePath: string): DatabaseHandle {
  const inMemory = filePath === ':memory:';
  if (!inMemory) mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

  const sqlite = new Database(filePath);
  // The database holds unpublished drafts: keep it private to the owner.
  // WAL and journal files inherit these permissions.
  if (!inMemory) chmodSync(filePath, 0o600);

  sqlite.pragma('journal_mode = WAL');
  // FULL durability: losing a committed "in_flight" attempt on power loss would
  // hide an ambiguous publication. Write volume is tiny, so the cost is negligible.
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle({ client: sqlite, schema });
  return { db, sqlite, close: () => sqlite.close() };
}

/** Applies pending migrations from ./drizzle. Safe to call on every start. */
export function migrateDatabase(handle: DatabaseHandle): void {
  migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}
