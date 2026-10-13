import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup, verifyDatabaseFile } from './backup.ts';
import { migrateDatabase, openDatabase } from './client.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'x-agent-backup-'));
  directories.push(directory);
  const handle = openDatabase(join(directory, 'agent.db'));
  migrateDatabase(handle);
  handle.sqlite
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('publication_paused', 'true', 0)",
    )
    .run();
  return { directory, handle, backups: join(directory, 'backups') };
}

describe('createBackup', () => {
  it('writes a private, verified copy containing the data', async () => {
    const { handle, backups } = setup();
    const result = await createBackup(handle, {
      directory: backups,
      now: new Date('2026-10-13T08:30:05Z'),
      keep: 5,
    });
    handle.close();

    expect(result.file).toBe(join(backups, 'agent-20261013-083005.db'));
    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(verifyDatabaseFile(result.file)).toBe(true);
    const copy = new Database(result.file, { readonly: true });
    expect(
      copy.prepare("SELECT value FROM settings WHERE key = 'publication_paused'").pluck().get(),
    ).toBe('true');
    copy.close();
  });

  it('keeps only the most recent backups', async () => {
    const { handle, backups } = setup();
    for (let day = 1; day <= 4; day += 1) {
      await createBackup(handle, {
        directory: backups,
        now: new Date(`2026-10-0${day}T00:00:00Z`),
        keep: 2,
      });
    }
    writeFileSync(join(backups, 'notes.txt'), 'not a backup');
    handle.close();
    expect(readdirSync(backups).sort()).toEqual([
      'agent-20261003-000000.db',
      'agent-20261004-000000.db',
      'notes.txt',
    ]);
  });

  it('detects a corrupt file', () => {
    const { directory, handle } = setup();
    handle.close();
    const broken = join(directory, 'broken.db');
    writeFileSync(broken, 'definitely not sqlite');
    expect(() => verifyDatabaseFile(broken)).toThrow();
  });
});
