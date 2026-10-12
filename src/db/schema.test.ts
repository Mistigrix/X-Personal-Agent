import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseHandle, migrateDatabase, openDatabase } from './client.ts';

const NOW = Date.UTC(2026, 9, 12, 9, 0);
const HASH = 'a'.repeat(64);

let handle: DatabaseHandle;
let sequence = 0;

beforeEach(() => {
  handle = openDatabase(':memory:');
  migrateDatabase(handle);
});
afterEach(() => handle.close());

function insert(table: string, row: Record<string, unknown>): number {
  const columns = Object.keys(row);
  const statement = handle.sqlite.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
  );
  return Number(statement.run(row).lastInsertRowid);
}

function insertPost(overrides: Record<string, unknown> = {}): number {
  sequence += 1;
  return insert('posts', {
    public_id: `P${sequence}`,
    source: 'personal',
    status: 'pending_confirmation',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

function insertVersion(postId: number, version = 1): number {
  return insert('post_versions', {
    post_id: postId,
    version,
    text: 'Hello',
    content_hash: HASH,
    weighted_length: 5,
    origin: 'user_submitted',
    created_at: NOW,
  });
}

function insertAttempt(postId: number, versionId: number, status: string): number {
  return insert('publication_attempts', {
    post_id: postId,
    post_version_id: versionId,
    content_hash: HASH,
    status,
    dry_run: 1,
    started_at: NOW,
  });
}

describe('database setup', () => {
  it('creates every table', () => {
    const tables = handle.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name <> 'sqlite_sequence' ORDER BY name",
      )
      .pluck()
      .all();
    expect(tables).toEqual([
      'approvals',
      'ideas',
      'job_runs',
      'post_versions',
      'posts',
      'publication_attempts',
      'settings',
    ]);
  });

  it('enables foreign keys and is safe to migrate repeatedly', () => {
    expect(handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => migrateDatabase(handle)).not.toThrow();
  });

  it('creates a private WAL database file on disk', () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-agent-db-'));
    const file = join(directory, 'nested', 'agent.db');
    const onDisk = openDatabase(file);
    try {
      migrateDatabase(onDisk);
      expect(onDisk.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(onDisk.sqlite.pragma('synchronous', { simple: true })).toBe(2); // FULL
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      onDisk.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('post constraints', () => {
  it('rejects unknown statuses and sources', () => {
    expect(() => insertPost({ status: 'posted' })).toThrow(/CHECK constraint/);
    expect(() => insertPost({ source: 'robot' })).toThrow(/CHECK constraint/);
  });

  it('keeps personal posts out of the AI review states and vice versa', () => {
    expect(() => insertPost({ source: 'personal', status: 'draft' })).toThrow(/CHECK constraint/);
    expect(() => insertPost({ source: 'ai', status: 'pending_confirmation' })).toThrow(
      /CHECK constraint/,
    );
    expect(() => insertPost({ source: 'ai', status: 'draft' })).not.toThrow();
  });

  it('requires a time for scheduled and published posts', () => {
    expect(() => insertPost({ status: 'scheduled' })).toThrow(/CHECK constraint/);
    expect(() => insertPost({ status: 'published', scheduled_at: NOW })).toThrow(
      /CHECK constraint/,
    );
  });

  it('allows one post per slot among slot-holding posts only', () => {
    insertPost({ status: 'scheduled', scheduled_at: NOW, slot_key: '2026-10-12#0' });
    expect(() =>
      insertPost({ status: 'scheduled', scheduled_at: NOW, slot_key: '2026-10-12#0' }),
    ).toThrow(/UNIQUE constraint/);
    // A cancelled post releases its slot.
    expect(() => insertPost({ status: 'cancelled', slot_key: '2026-10-12#0' })).not.toThrow();
  });

  it('never stores the same X post ID twice', () => {
    insertPost({ status: 'published', published_at: NOW, x_post_id: '1844' });
    expect(() => insertPost({ status: 'published', published_at: NOW, x_post_id: '1844' })).toThrow(
      /UNIQUE constraint/,
    );
  });
});

describe('versions, approvals and attempts', () => {
  it('enforces foreign keys', () => {
    expect(() => insertVersion(9999)).toThrow(/FOREIGN KEY constraint/);
  });

  it('numbers versions uniquely per post', () => {
    const postId = insertPost({ source: 'ai', status: 'draft' });
    insertVersion(postId, 1);
    expect(() => insertVersion(postId, 1)).toThrow(/UNIQUE constraint/);
    expect(() => insertVersion(postId, 2)).not.toThrow();
  });

  it('records at most one decision per version', () => {
    const postId = insertPost({ source: 'ai', status: 'draft' });
    const versionId = insertVersion(postId);
    const approval = {
      post_id: postId,
      post_version_id: versionId,
      content_hash: HASH,
      decision: 'approved',
      telegram_user_id: 111111,
      decided_at: NOW,
    };
    insert('approvals', approval);
    expect(() => insert('approvals', approval)).toThrow(/UNIQUE constraint/);
  });

  it('allows only one open publication attempt per post', () => {
    const postId = insertPost({ status: 'publishing', scheduled_at: NOW });
    const versionId = insertVersion(postId);
    insertAttempt(postId, versionId, 'in_flight');
    expect(() => insertAttempt(postId, versionId, 'in_flight')).toThrow(/UNIQUE constraint/);
    expect(() => insertAttempt(postId, versionId, 'unknown')).toThrow(/UNIQUE constraint/);
    expect(() => insertAttempt(postId, versionId, 'failed_retryable')).not.toThrow();
  });

  it('runs each job at most once per run key', () => {
    const run = {
      job_name: 'daily-drafts',
      run_key: '2026-10-12',
      status: 'running',
      started_at: NOW,
    };
    insert('job_runs', run);
    expect(() => insert('job_runs', run)).toThrow(/UNIQUE constraint/);
  });
});
