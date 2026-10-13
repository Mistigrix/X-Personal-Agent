/**
 * Creates a consistent, verified copy of the database, safe to run while the
 * agent is running.
 * Usage: pnpm db:backup [--dir local/backups] [--keep 14]
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DATABASE_PATH } from '../src/config/env.ts';
import { toDisplayPath } from '../src/config/load.ts';
import { createBackup } from '../src/db/backup.ts';
import { openDatabase } from '../src/db/client.ts';
import { readEnvironment } from '../src/shared/dotenv.ts';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'local/backups' },
    keep: { type: 'string', default: '14' },
  },
});
const keep = Number(values.keep);
if (!Number.isInteger(keep) || keep < 1) {
  console.error('--keep must be a positive integer');
  process.exit(2);
}

const databasePath = resolve(root, readEnvironment(root).DATABASE_PATH || DEFAULT_DATABASE_PATH);
const handle = openDatabase(databasePath);
try {
  const result = await createBackup(handle, {
    directory: resolve(root, values.dir),
    now: new Date(),
    keep,
  });
  console.log(
    `Backup written and verified: ${toDisplayPath(root, result.file)} (${result.bytes} bytes)`,
  );
  for (const file of result.removed) console.log(`Removed old backup: ${file}`);
} finally {
  handle.close();
}
