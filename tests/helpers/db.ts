/** Direct database access for assertions and for setting up states the UI cannot create yet. */
import { contentHash, weightedLength } from '../../src/domain/text.ts';
import type { PostView } from '../../src/services/post-view.ts';
import type { TestServices } from './services.ts';

export interface PostState {
  id: number;
  status: string;
  retry_count: number;
  scheduled_at: number | null;
  slot_key: string | null;
  x_post_id: string | null;
  published_at: number | null;
  last_error: string | null;
  current_version: number;
}

export interface AttemptState {
  id: number;
  status: string;
  dry_run: number;
  error_code: string | null;
  x_post_id: string | null;
  reconcile_checks: number;
  notified_at: number | null;
}

export function postState(services: TestServices, publicId: string): PostState {
  const row = services.handle.sqlite
    .prepare('SELECT * FROM posts WHERE public_id = ?')
    .get(publicId);
  if (!row) throw new Error(`No post ${publicId}`);
  return row as PostState;
}

export function attemptsOf(services: TestServices, publicId: string): AttemptState[] {
  return services.handle.sqlite
    .prepare(
      'SELECT a.* FROM publication_attempts a JOIN posts p ON p.id = a.post_id WHERE p.public_id = ? ORDER BY a.id',
    )
    .all(publicId) as AttemptState[];
}

/** Submits and confirms a personal post, then moves the clock to its publication time. */
export function duePersonalPost(services: TestServices, text = 'Hello X'): PostView {
  const submitted = services.queue.submitPersonalPost(text);
  if (submitted.kind !== 'needs_confirmation') throw new Error(`unexpected ${submitted.kind}`);
  const confirmed = services.queue.confirm(submitted.post.publicId, 1);
  if (confirmed.kind !== 'queued') throw new Error(`unexpected ${confirmed.kind}`);
  services.clock.set(confirmed.slot.at);
  return confirmed.post;
}

/**
 * Inserts a scheduled AI post (the approval workflow arrives in Milestone 5).
 * `approval` controls which decision exists: none, for the current version, or
 * for a previous version.
 */
export function insertScheduledAiPost(
  services: TestServices,
  options: {
    publicId: string;
    text: string;
    approval: 'none' | 'current' | 'previous' | 'rejected';
  },
): void {
  const { sqlite } = services.handle;
  const now = services.clock.now().getTime();
  const versions = options.approval === 'previous' ? 2 : 1;
  const postId = Number(
    sqlite
      .prepare(
        `INSERT INTO posts (public_id, source, status, current_version, scheduled_at, slot_key, created_at, updated_at)
         VALUES (?, 'ai', 'scheduled', ?, ?, ?, ?, ?)`,
      )
      .run(options.publicId, versions, now - 1000, `ai-${options.publicId}`, now, now)
      .lastInsertRowid,
  );
  const versionIds: number[] = [];
  for (let version = 1; version <= versions; version += 1) {
    const text = version === versions ? options.text : `${options.text} (earlier draft)`;
    versionIds.push(
      Number(
        sqlite
          .prepare(
            `INSERT INTO post_versions (post_id, version, text, content_hash, weighted_length, origin, created_at)
             VALUES (?, ?, ?, ?, ?, 'ai_generated', ?)`,
          )
          .run(postId, version, text, contentHash(text), weightedLength(text), now).lastInsertRowid,
      ),
    );
  }
  if (options.approval === 'none') return;
  const approvedIndex = options.approval === 'previous' ? 0 : versionIds.length - 1;
  const approvedVersionId = versionIds[approvedIndex] ?? 0;
  const approvedText = sqlite
    .prepare('SELECT text FROM post_versions WHERE id = ?')
    .pluck()
    .get(approvedVersionId) as string;
  sqlite
    .prepare(
      `INSERT INTO approvals (post_id, post_version_id, content_hash, decision, telegram_user_id, decided_at)
       VALUES (?, ?, ?, ?, 111111, ?)`,
    )
    .run(
      postId,
      approvedVersionId,
      contentHash(approvedText),
      options.approval === 'rejected' ? 'rejected' : 'approved',
      now,
    );
}
