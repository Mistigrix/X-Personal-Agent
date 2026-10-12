/**
 * Database schema (SQLite via Drizzle).
 *
 * Conventions:
 * - Timestamps are stored as INTEGER Unix epoch milliseconds in UTC
 *   (`timestamp_ms` mode maps them to `Date`). Timezone conversion happens only
 *   at the edges (display and slot computation).
 * - Enumerations are TEXT columns guarded by CHECK constraints.
 * - Invariants that protect publication (one decision per version, one open
 *   attempt per post, one post per slot) are enforced by unique indexes, not only
 *   by application code.
 */
import { type SQL, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { IDEA_STATUSES } from '../domain/idea.ts';
import {
  APPROVAL_DECISIONS,
  POST_SOURCES,
  POST_STATUSES,
  SLOT_HOLDING_STATUSES,
  VERSION_ORIGINS,
} from '../domain/post.ts';
import { ATTEMPT_STATUSES, OPEN_ATTEMPT_STATUSES } from '../domain/publication.ts';

export const JOB_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;

/** `column IN ('a', 'b')` for compile-time constant values (never user input). */
function isOneOf(column: string, values: readonly string[]): SQL {
  return sql.raw(`${column} IN (${values.map((value) => `'${value}'`).join(', ')})`);
}

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobName: text('job_name').notNull(),
    /** Idempotency key, e.g. `daily-drafts:2026-10-12` (local date). */
    runKey: text('run_key').notNull(),
    status: text('status', { enum: JOB_RUN_STATUSES }).notNull(),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at'),
    error: text('error'),
    /** Counts, token usage and other diagnostics. Never secrets. */
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('job_runs_job_name_run_key_uq').on(t.jobName, t.runKey),
    index('job_runs_job_name_started_at_idx').on(t.jobName, t.startedAt),
    check('job_runs_status_check', isOneOf('status', JOB_RUN_STATUSES)),
  ],
);

/** Runtime state that must survive restarts (pause flag, instance lease, cached X user id). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const ideas = sqliteTable(
  'ideas',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id').notNull().unique(),
    topic: text('topic').notNull(),
    angle: text('angle').notNull(),
    category: text('category').notNull(),
    language: text('language').notNull(),
    rationale: text('rationale'),
    /** Which profile sections/facts the idea relies on. */
    profileRefs: text('profile_refs', { mode: 'json' }).$type<string[]>(),
    /** Normalized fingerprint used for duplicate detection. */
    fingerprint: text('fingerprint').notNull(),
    status: text('status', { enum: IDEA_STATUSES }).notNull(),
    jobRunId: integer('job_run_id').references(() => jobRuns.id),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    index('ideas_status_idx').on(t.status),
    index('ideas_fingerprint_idx').on(t.fingerprint),
    check('ideas_status_check', isOneOf('status', IDEA_STATUSES)),
  ],
);

export const posts = sqliteTable(
  'posts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Short identifier shown in Telegram (e.g. `P7K2QX`). Never the primary key. */
    publicId: text('public_id').notNull().unique(),
    source: text('source', { enum: POST_SOURCES }).notNull(),
    status: text('status', { enum: POST_STATUSES }).notNull(),
    /** Version number of the current content in `post_versions`. */
    currentVersion: integer('current_version').notNull().default(1),
    /** ISO 639-1 code; null when unknown (personal posts are never analysed). */
    language: text('language'),
    ideaId: integer('idea_id').references(() => ideas.id),
    /** Next time the publisher may claim this post (UTC). */
    scheduledAt: timestamp('scheduled_at'),
    /** Publication slot identity, e.g. `2026-10-14#1` (local date + window index). */
    slotKey: text('slot_key'),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    xPostId: text('x_post_id').unique(),
    publishedAt: timestamp('published_at'),
    /** Telegram message holding this post's interactive card (preview or review). */
    cardChatId: integer('card_chat_id'),
    cardMessageId: integer('card_message_id'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (t) => [
    index('posts_status_scheduled_at_idx').on(t.status, t.scheduledAt),
    index('posts_idea_id_idx').on(t.ideaId),
    uniqueIndex('posts_slot_key_holding_uq')
      .on(t.slotKey)
      .where(isOneOf('status', SLOT_HOLDING_STATUSES)),
    check('posts_source_check', isOneOf('source', POST_SOURCES)),
    check('posts_status_check', isOneOf('status', POST_STATUSES)),
    check('posts_current_version_check', sql.raw('current_version >= 1')),
    check('posts_retry_count_check', sql.raw('retry_count >= 0')),
    check(
      'posts_source_status_check',
      sql.raw(
        "NOT (source = 'personal' AND status IN ('draft', 'rejected')) AND NOT (source = 'ai' AND status = 'pending_confirmation')",
      ),
    ),
    check(
      'posts_scheduled_has_time_check',
      sql.raw("status <> 'scheduled' OR scheduled_at IS NOT NULL"),
    ),
    check(
      'posts_published_has_time_check',
      sql.raw("status <> 'published' OR published_at IS NOT NULL"),
    ),
  ],
);

export const postVersions = sqliteTable(
  'post_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id),
    version: integer('version').notNull(),
    /** Exact text, stored verbatim. Never normalized or trimmed. */
    text: text('text').notNull(),
    /** SHA-256 (hex) of the exact UTF-8 text; approvals are bound to it. */
    contentHash: text('content_hash').notNull(),
    /** Length as counted by X (weighted). */
    weightedLength: integer('weighted_length').notNull(),
    origin: text('origin', { enum: VERSION_ORIGINS }).notNull(),
    /** Results of content checks: warnings, scores, claim audit. */
    checks: text('checks', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Generation metadata for AI versions: model, prompt template hash, token usage. */
    generation: text('generation', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('post_versions_post_id_version_uq').on(t.postId, t.version),
    check('post_versions_version_check', sql.raw('version >= 1')),
    check('post_versions_content_hash_check', sql.raw('length(content_hash) = 64')),
    check('post_versions_origin_check', isOneOf('origin', VERSION_ORIGINS)),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id),
    postVersionId: integer('post_version_id')
      .notNull()
      .references(() => postVersions.id),
    /** Hash of the exact text the user saw when deciding. */
    contentHash: text('content_hash').notNull(),
    decision: text('decision', { enum: APPROVAL_DECISIONS }).notNull(),
    telegramUserId: integer('telegram_user_id').notNull(),
    decidedAt: timestamp('decided_at').notNull(),
  },
  (t) => [
    // One decision per version: duplicate clicks cannot create a second approval,
    // and any edit produces a new version that needs its own decision.
    uniqueIndex('approvals_post_version_id_uq').on(t.postVersionId),
    index('approvals_post_id_idx').on(t.postId),
    check('approvals_decision_check', isOneOf('decision', APPROVAL_DECISIONS)),
    check('approvals_content_hash_check', sql.raw('length(content_hash) = 64')),
  ],
);

export const publicationAttempts = sqliteTable(
  'publication_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id),
    postVersionId: integer('post_version_id')
      .notNull()
      .references(() => postVersions.id),
    /** Hash of the exact text sent (or about to be sent) to X. */
    contentHash: text('content_hash').notNull(),
    status: text('status', { enum: ATTEMPT_STATUSES }).notNull(),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull(),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at'),
    httpStatus: integer('http_status'),
    errorCode: text('error_code'),
    /** Sanitized error description. Never contains credentials. */
    errorMessage: text('error_message'),
    xPostId: text('x_post_id'),
    /** Earliest retry time when X asked us to back off (e.g. rate limit reset). */
    retryAfter: timestamp('retry_after'),
    reconcileChecks: integer('reconcile_checks').notNull().default(0),
    lastReconciledAt: timestamp('last_reconciled_at'),
    /** Set once the user has been notified of the attempt's final outcome. */
    notifiedAt: timestamp('notified_at'),
  },
  (t) => [
    // At most one in-flight or unresolved attempt per post.
    uniqueIndex('publication_attempts_open_per_post_uq')
      .on(t.postId)
      .where(isOneOf('status', OPEN_ATTEMPT_STATUSES)),
    index('publication_attempts_post_id_idx').on(t.postId),
    index('publication_attempts_status_idx').on(t.status),
    check('publication_attempts_status_check', isOneOf('status', ATTEMPT_STATUSES)),
    check('publication_attempts_content_hash_check', sql.raw('length(content_hash) = 64')),
    check('publication_attempts_reconcile_checks_check', sql.raw('reconcile_checks >= 0')),
  ],
);
