import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { type AttemptStatus, OPEN_ATTEMPT_STATUSES } from '../../domain/publication.ts';
import type { DbExecutor } from '../client.ts';
import { posts, postVersions, publicationAttempts } from '../schema.ts';
import type { PostRow, PostVersionRow } from './posts.ts';

export type AttemptRow = typeof publicationAttempts.$inferSelect;

/** An attempt with its post and the exact version it sent. */
export interface AttemptRecord {
  attempt: AttemptRow;
  post: PostRow;
  version: PostVersionRow;
}

export function insertAttempt(
  db: DbExecutor,
  input: {
    postId: number;
    postVersionId: number;
    contentHash: string;
    dryRun: boolean;
    startedAt: Date;
  },
): AttemptRow {
  return db
    .insert(publicationAttempts)
    .values({ ...input, status: 'in_flight' })
    .returning()
    .get();
}

export type AttemptChanges = Partial<
  Pick<
    AttemptRow,
    | 'status'
    | 'finishedAt'
    | 'httpStatus'
    | 'errorCode'
    | 'errorMessage'
    | 'xPostId'
    | 'retryAfter'
    | 'reconcileChecks'
    | 'lastReconciledAt'
    | 'notifiedAt'
  >
>;

/** Updates an attempt only if it is still in `expectedStatus`. */
export function updateAttempt(
  db: DbExecutor,
  id: number,
  expectedStatus: AttemptStatus,
  changes: AttemptChanges,
): boolean {
  const result = db
    .update(publicationAttempts)
    .set(changes)
    .where(and(eq(publicationAttempts.id, id), eq(publicationAttempts.status, expectedStatus)))
    .run();
  return result.changes === 1;
}

export function findOpenAttempt(db: DbExecutor, postId: number): AttemptRow | undefined {
  return db
    .select()
    .from(publicationAttempts)
    .where(
      and(
        eq(publicationAttempts.postId, postId),
        inArray(publicationAttempts.status, [...OPEN_ATTEMPT_STATUSES]),
      ),
    )
    .get();
}

function selectRecords(db: DbExecutor) {
  return db
    .select({ attempt: publicationAttempts, post: posts, version: postVersions })
    .from(publicationAttempts)
    .innerJoin(posts, eq(posts.id, publicationAttempts.postId))
    .innerJoin(postVersions, eq(postVersions.id, publicationAttempts.postVersionId));
}

export function listAttemptsByStatus(db: DbExecutor, status: AttemptStatus): AttemptRecord[] {
  return selectRecords(db).where(eq(publicationAttempts.status, status)).all();
}

export function findAttemptRecord(db: DbExecutor, id: number): AttemptRecord | undefined {
  return selectRecords(db).where(eq(publicationAttempts.id, id)).get();
}

/** Finished attempts whose outcome has not been delivered to the user yet. */
export function listUnnotifiedAttempts(db: DbExecutor): AttemptRecord[] {
  return selectRecords(db)
    .where(and(isNull(publicationAttempts.notifiedAt), ne(publicationAttempts.status, 'in_flight')))
    .orderBy(publicationAttempts.id)
    .all();
}

export function markAttemptNotified(db: DbExecutor, id: number, now: Date): void {
  db.update(publicationAttempts)
    .set({ notifiedAt: now })
    .where(eq(publicationAttempts.id, id))
    .run();
}
