import { and, asc, count, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
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
  text: string;
  contentHash: string;
  weightedLength: number;
  origin: VersionOrigin;
  checks?: Record<string, unknown> | null;
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
      createdAt: input.now,
    })
    .returning()
    .get();
  return { post, version };
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
  Pick<PostRow, 'status' | 'scheduledAt' | 'slotKey' | 'lastError' | 'cardChatId' | 'cardMessageId'>
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
