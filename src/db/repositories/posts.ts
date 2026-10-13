import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import {
  type PostSource,
  type PostStatus,
  SLOT_HOLDING_STATUSES,
  type VersionOrigin,
} from '../../domain/post.ts';
import type { DbExecutor } from '../client.ts';
import { posts, postVersions } from '../schema.ts';

export type PostRow = typeof posts.$inferSelect;
export type PostVersionRow = typeof postVersions.$inferSelect;

/** A post together with its current version. */
export interface PostRecord {
  post: PostRow;
  version: PostVersionRow;
}

export interface NewPost {
  publicId: string;
  source: PostSource;
  status: PostStatus;
  scheduledAt?: Date | null;
  slotKey?: string | null;
  language?: string | null;
  ideaId?: number | null;
  text: string;
  contentHash: string;
  weightedLength: number;
  origin: VersionOrigin;
  checks?: Record<string, unknown> | null;
  generation?: Record<string, unknown> | null;
  now: Date;
}

export function insertPostWithFirstVersion(db: DbExecutor, input: NewPost): PostRecord {
  const post = db
    .insert(posts)
    .values({
      publicId: input.publicId,
      source: input.source,
      status: input.status,
      currentVersion: 1,
      language: input.language ?? null,
      ideaId: input.ideaId ?? null,
      scheduledAt: input.scheduledAt ?? null,
      slotKey: input.slotKey ?? null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .get();
  const version = db
    .insert(postVersions)
    .values({
      postId: post.id,
      version: 1,
      text: input.text,
      contentHash: input.contentHash,
      weightedLength: input.weightedLength,
      origin: input.origin,
      checks: input.checks ?? null,
      generation: input.generation ?? null,
      createdAt: input.now,
    })
    .returning()
    .get();
  return { post, version };
}

export interface NewVersion {
  postId: number;
  version: number;
  text: string;
  contentHash: string;
  weightedLength: number;
  origin: VersionOrigin;
  checks?: Record<string, unknown> | null;
  generation?: Record<string, unknown> | null;
  now: Date;
}

/** Adds a version. The caller then points `posts.current_version` at it. */
export function insertVersion(db: DbExecutor, input: NewVersion): PostVersionRow {
  const { now, ...values } = input;
  return db
    .insert(postVersions)
    .values({
      ...values,
      checks: values.checks ?? null,
      generation: values.generation ?? null,
      createdAt: now,
    })
    .returning()
    .get();
}

/** Current texts of the most recent posts in the given statuses, newest first. */
export function listRecentTexts(
  db: DbExecutor,
  statuses: readonly PostStatus[],
  limit: number,
): string[] {
  return db
    .select({ text: postVersions.text })
    .from(posts)
    .innerJoin(postVersions, currentVersionJoin)
    .where(inArray(posts.status, [...statuses]))
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit)
    .all()
    .map((row) => row.text);
}

export function findByIdeaId(db: DbExecutor, ideaId: number): PostRecord | undefined {
  return db
    .select({ post: posts, version: postVersions })
    .from(posts)
    .innerJoin(postVersions, currentVersionJoin)
    .where(eq(posts.ideaId, ideaId))
    .get();
}

export function publicIdExists(db: DbExecutor, publicId: string): boolean {
  return (
    db.select({ id: posts.id }).from(posts).where(eq(posts.publicId, publicId)).get() !== undefined
  );
}

const currentVersionJoin = and(
  eq(postVersions.postId, posts.id),
  eq(postVersions.version, posts.currentVersion),
);

export function findByPublicId(db: DbExecutor, publicId: string): PostRecord | undefined {
  return db
    .select({ post: posts, version: postVersions })
    .from(posts)
    .innerJoin(postVersions, currentVersionJoin)
    .where(eq(posts.publicId, publicId))
    .get();
}

/** Posts in the given statuses, soonest first; posts without a time come last. */
export function listByStatuses(
  db: DbExecutor,
  statuses: readonly PostStatus[],
  limit: number,
): PostRecord[] {
  return db
    .select({ post: posts, version: postVersions })
    .from(posts)
    .innerJoin(postVersions, currentVersionJoin)
    .where(inArray(posts.status, [...statuses]))
    .orderBy(sql`${posts.scheduledAt} IS NULL`, asc(posts.scheduledAt), asc(posts.createdAt))
    .limit(limit)
    .all();
}

export function findById(db: DbExecutor, id: number): PostRecord | undefined {
  return db
    .select({ post: posts, version: postVersions })
    .from(posts)
    .innerJoin(postVersions, currentVersionJoin)
    .where(eq(posts.id, id))
    .get();
}

/** Scheduled posts due at `now`, earliest first. */
export function listDueScheduled(db: DbExecutor, now: Date, limit: number): PostRecord[] {
  return db
    .select({ post: posts, version: postVersions })
    .from(posts)
    .innerJoin(postVersions, currentVersionJoin)
    .where(and(eq(posts.status, 'scheduled'), lte(posts.scheduledAt, now)))
    .orderBy(asc(posts.scheduledAt), asc(posts.id))
    .limit(limit)
    .all();
}

/** Scheduled posts whose time is before `before` (missed during a pause or downtime). */
export function listOverdueScheduled(db: DbExecutor, before: Date): PostRow[] {
  return db
    .select()
    .from(posts)
    .where(and(eq(posts.status, 'scheduled'), lt(posts.scheduledAt, before)))
    .orderBy(asc(posts.scheduledAt), asc(posts.id))
    .all();
}

export function xPostIdExists(db: DbExecutor, xPostId: string): boolean {
  return (
    db.select({ id: posts.id }).from(posts).where(eq(posts.xPostId, xPostId)).get() !== undefined
  );
}

export function countByStatuses(
  db: DbExecutor,
  statuses: readonly PostStatus[],
): Partial<Record<PostStatus, number>> {
  const rows = db
    .select({ status: posts.status, total: count() })
    .from(posts)
    .where(inArray(posts.status, [...statuses]))
    .groupBy(posts.status)
    .all();
  return Object.fromEntries(rows.map((row) => [row.status, row.total]));
}

/** Slot keys held by posts scheduled at or after `since`. */
export function takenSlotKeys(db: DbExecutor, since: Date): Set<string> {
  const rows = db
    .select({ slotKey: posts.slotKey })
    .from(posts)
    .where(
      and(
        inArray(posts.status, [...SLOT_HOLDING_STATUSES]),
        isNotNull(posts.slotKey),
        gte(posts.scheduledAt, since),
      ),
    )
    .all();
  return new Set(rows.flatMap((row) => (row.slotKey === null ? [] : [row.slotKey])));
}

export type PostChanges = Partial<
  Pick<
    PostRow,
    | 'status'
    | 'currentVersion'
    | 'scheduledAt'
    | 'slotKey'
    | 'retryCount'
    | 'lastError'
    | 'xPostId'
    | 'publishedAt'
    | 'cardChatId'
    | 'cardMessageId'
  >
> & { updatedAt: Date };

/**
 * Updates a post only if it is still in `expectedStatus` (optimistic check).
 * Returns false when another operation changed it first.
 */
export function updatePost(
  db: DbExecutor,
  id: number,
  expectedStatus: PostStatus,
  changes: PostChanges,
): boolean {
  const result = db
    .update(posts)
    .set(changes)
    .where(and(eq(posts.id, id), eq(posts.status, expectedStatus)))
    .run();
  return result.changes === 1;
}

/** Records the Telegram message that displays this post's card. */
export function setCardMessage(
  db: DbExecutor,
  id: number,
  card: { chatId: number; messageId: number },
  now: Date,
): void {
  db.update(posts)
    .set({ cardChatId: card.chatId, cardMessageId: card.messageId, updatedAt: now })
    .where(eq(posts.id, id))
    .run();
}

/** AI posts in a status, oldest first (e.g. drafts waiting for review). */
export function listAiPosts(db: DbExecutor, status: PostStatus, limit: number): PostRecord[] {
  return db
    .select({ post: posts, version: postVersions })
    .from(posts)
    .innerJoin(postVersions, currentVersionJoin)
    .where(and(eq(posts.source, 'ai'), eq(posts.status, status)))
    .orderBy(asc(posts.createdAt), asc(posts.id))
    .limit(limit)
    .all();
}

export function countAiPosts(db: DbExecutor, status: PostStatus): number {
  return (
    db
      .select({ total: count() })
      .from(posts)
      .where(and(eq(posts.source, 'ai'), eq(posts.status, status)))
      .get()?.total ?? 0
  );
}
