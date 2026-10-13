/**
 * Online backups with SQLite's backup API: consistent even while the agent is
 * running (WAL mode). Every copy is integrity-checked; old copies are rotated.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseHandle } from './client.ts';

const BACKUP_FILE = /^agent-\d{8}-\d{6}\.db$/;

export interface BackupResult {
  file: string;
  bytes: number;
  /** Older backups deleted to respect `keep`. */
  removed: string[];
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Opens a database file read-only and runs SQLite's integrity check. */
export function verifyDatabaseFile(file: string): boolean {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return copy.pragma('integrity_check', { simple: true }) === 'ok';
  } finally {
    copy.close();
  }
}

export async function createBackup(
  handle: DatabaseHandle,
  options: { directory: string; now: Date; keep: number },
): Promise<BackupResult> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const file = join(options.directory, `agent-${timestamp(options.now)}.db`);
  await handle.sqlite.backup(file);
  chmodSync(file, 0o600);
  // The copy inherits WAL mode; switch it to a single self-contained file and verify it.
  const copy = new Database(file, { fileMustExist: true });
  let intact = false;
  try {
    copy.pragma('journal_mode = DELETE');
    intact = copy.pragma('integrity_check', { simple: true }) === 'ok';
  } finally {
    copy.close();
  }
  if (!intact) {
    rmSync(file, { force: true });
    throw new Error('The backup failed its integrity check and was deleted.');
  }

  const backups = readdirSync(options.directory)
    .filter((name) => BACKUP_FILE.test(name))
    .sort();
  const removed = backups.slice(0, Math.max(0, backups.length - options.keep));
  for (const name of removed) rmSync(join(options.directory, name), { force: true });
  return { file, bytes: statSync(file).size, removed };
}
