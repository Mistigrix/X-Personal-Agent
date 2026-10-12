/**
 * Publication: claim a due post, send it to X, record the outcome.
 *
 * Exactly-once delivery is impossible without an idempotency key, so the design
 * guarantees at most one automatic send per post version:
 * - the attempt is recorded (in its own transaction) BEFORE the request is sent;
 * - no transaction is held open during the network call;
 * - an ambiguous outcome makes the post `uncertain`, and it is never resent
 *   automatically: the reconciler checks the timeline, then the user decides.
 */
import type { AppDatabase, DbExecutor } from '../db/client.ts';
import { findApprovalForVersion } from '../db/repositories/approvals.ts';
import {
  type AttemptRow,
  findOpenAttempt,
  insertAttempt,
  listAttemptsByStatus,
  updateAttempt,
} from '../db/repositories/attempts.ts';
import {
  findByPublicId,
  listDueScheduled,
  type PostChanges,
  type PostRow,
  type PostVersionRow,
  updatePost,
} from '../db/repositories/posts.ts';
import { assertTransition, type PostStatus } from '../domain/post.ts';
import { RESOLVED_BY_USER, retryDelayMs } from '../domain/publication.ts';
import { type BlockReason, checkPublication } from '../domain/publication-policy.ts';
import type { Slot } from '../domain/scheduling.ts';
import type { CreatePostResult, XClient } from '../integrations/x/x-client.ts';
import type { Clock } from '../shared/clock.ts';
import type { Logger } from '../shared/logger.ts';
import { type PostView, toPostView } from './post-view.ts';
import type { SchedulerService } from './scheduler-service.ts';

export interface PublisherSettings {
  maxRetries: number;
  retryBaseDelaySeconds: number;
}

export type PublishOutcome =
  | { publicId: string; result: 'published' | 'retry_scheduled' | 'failed' | 'uncertain' }
  | { publicId: string; result: 'blocked'; reason: BlockReason };

export type RetryResult =
  | { kind: 'rescheduled'; post: PostView; slot: Slot }
  | { kind: 'not_retryable'; post: PostView }
  | { kind: 'outdated'; post: PostView }
  | { kind: 'queue_full'; post: PostView }
  | { kind: 'not_found' };

export type MarkPublishedResult =
  | { kind: 'marked'; post: PostView }
  | { kind: 'not_uncertain'; post: PostView }
  | { kind: 'outdated'; post: PostView }
  | { kind: 'not_found' };

export interface PublisherService {
  /** Startup recovery: attempts interrupted by a crash become uncertain. Returns their count. */
  recoverInterrupted(): number;
  /** Publishes the earliest due post, if any. At most one post per call. */
  publishNextDue(): Promise<PublishOutcome | null>;
  /** User decision: schedule a failed or uncertain post again (in the next free slot). */
  retry(publicId: string, version: number): RetryResult;
  /** User decision: an uncertain post is in fact on X. */
  markPublished(publicId: string, version: number): MarkPublishedResult;
}

type Claim =
  | { kind: 'claimed'; post: PostRow; version: PostVersionRow; attempt: AttemptRow }
  | { kind: 'blocked'; post: PostRow; reason: BlockReason };

const IMMEDIATE = { behavior: 'immediate' } as const;

/** Reasons that only mean "not now": the post stays scheduled. */
const WAIT_REASONS: readonly BlockReason[] = ['not_scheduled', 'not_due', 'paused'];

export function createPublisherService(deps: {
  db: AppDatabase;
  xClient: XClient;
  scheduler: SchedulerService;
  clock: Clock;
  logger: Logger;
  settings: PublisherSettings;
}): PublisherService {
  const { db, xClient, scheduler, clock, logger, settings } = deps;

  function transition(
    tx: DbExecutor,
    post: PostRow,
    from: PostStatus,
    to: PostStatus,
    changes: Omit<PostChanges, 'status' | 'updatedAt'>,
  ): void {
    assertTransition(post.source, from, to);
    if (!updatePost(tx, post.id, from, { ...changes, status: to, updatedAt: clock.now() })) {
      throw new Error(`Post ${post.publicId} changed concurrently (expected ${from})`);
    }
  }

  function claim(): Claim | null {
    return db.transaction((tx): Claim | null => {
      const now = clock.now();
      const [record] = listDueScheduled(tx, now, 1);
      if (!record) return null;
      const { post, version } = record;

      const approval = findApprovalForVersion(tx, version.id) ?? null;
      const decision = checkPublication({
        post,
        version,
        approval,
        hasOpenAttempt: findOpenAttempt(tx, post.id) !== undefined,
        paused: scheduler.isPaused(),
        now,
      });

      if (!decision.publishable) {
        if (WAIT_REASONS.includes(decision.reason)) return null;
        // An inconsistent post is taken out of the schedule so it can neither be
        // sent nor block the posts behind it. AI posts go back to review.
        const needsReview =
          post.source === 'ai' &&
          (decision.reason === 'missing_approval' || decision.reason === 'approval_mismatch');
        transition(tx, post, 'scheduled', needsReview ? 'draft' : 'failed', {
          lastError: `Blocked before publication (${decision.reason}).`,
        });
        return { kind: 'blocked', post, reason: decision.reason };
      }

      const attempt = insertAttempt(tx, {
        postId: post.id,
        postVersionId: version.id,
        contentHash: version.contentHash,
        dryRun: xClient.dryRun,
        startedAt: now,
      });
      transition(tx, post, 'scheduled', 'publishing', {});
      return { kind: 'claimed', post, version, attempt };
    }, IMMEDIATE);
  }

  function recordOutcome(
    post: PostRow,
    attempt: AttemptRow,
    result: CreatePostResult,
  ): PublishOutcome {
    return db.transaction((tx): PublishOutcome => {
      const now = clock.now();
      const publicId = post.publicId;

      if (result.kind === 'published') {
        updateAttempt(tx, attempt.id, 'in_flight', {
          status: 'succeeded',
          finishedAt: now,
          xPostId: result.postId,
        });
        transition(tx, post, 'publishing', 'published', {
          publishedAt: now,
          xPostId: result.postId,
          lastError: null,
        });
        return { publicId, result: 'published' };
      }

      const failure = {
        finishedAt: now,
        httpStatus: result.httpStatus ?? null,
        errorCode: result.code,
        errorMessage: result.message,
      };

      if (result.kind === 'unknown') {
        updateAttempt(tx, attempt.id, 'in_flight', { ...failure, status: 'unknown' });
        transition(tx, post, 'publishing', 'uncertain', { lastError: result.message });
        return { publicId, result: 'uncertain' };
      }

      const retriesLeft = result.retryable && post.retryCount < settings.maxRetries;
      updateAttempt(tx, attempt.id, 'in_flight', {
        ...failure,
        status: result.retryable ? 'failed_retryable' : 'failed_permanent',
        retryAfter: result.retryAt ?? null,
        // A transient failure with retries left is not worth a notification.
        notifiedAt: retriesLeft ? now : null,
      });

      if (retriesLeft) {
        const backoff =
          now.getTime() + retryDelayMs(post.retryCount, settings.retryBaseDelaySeconds);
        const retryAt = Math.max(backoff, result.retryAt?.getTime() ?? 0);
        transition(tx, post, 'publishing', 'scheduled', {
          scheduledAt: new Date(retryAt),
          retryCount: post.retryCount + 1,
          lastError: result.message,
        });
        return { publicId, result: 'retry_scheduled' };
      }

      transition(tx, post, 'publishing', 'failed', { lastError: result.message });
      return { publicId, result: 'failed' };
    }, IMMEDIATE);
  }

  /** Closes the open attempt of a post the user resolved by hand. */
  function closeOpenAttempt(tx: DbExecutor, postId: number, found: boolean, now: Date): void {
    const open = findOpenAttempt(tx, postId);
    if (!open) return;
    updateAttempt(tx, open.id, open.status, {
      status: found ? 'reconciled_found' : 'reconciled_not_found',
      finishedAt: open.finishedAt ?? now,
      errorCode: RESOLVED_BY_USER,
      notifiedAt: now,
    });
  }

  return {
    recoverInterrupted() {
      return db.transaction((tx) => {
        const now = clock.now();
        const interrupted = listAttemptsByStatus(tx, 'in_flight');
        for (const { attempt, post } of interrupted) {
          updateAttempt(tx, attempt.id, 'in_flight', {
            status: 'unknown',
            finishedAt: now,
            errorCode: 'interrupted',
            errorMessage: 'The agent stopped while this post was being published.',
          });
          if (post.status === 'publishing') {
            transition(tx, post, 'publishing', 'uncertain', {
              lastError: 'Interrupted during publication.',
            });
          }
        }
        return interrupted.length;
      }, IMMEDIATE);
    },

    async publishNextDue() {
      const claimed = claim();
      if (claimed === null) return null;
      if (claimed.kind === 'blocked') {
        logger.error(
          { postId: claimed.post.publicId, reason: claimed.reason },
          'Post blocked before publication and removed from the schedule',
        );
        return { publicId: claimed.post.publicId, result: 'blocked', reason: claimed.reason };
      }

      const { post, version, attempt } = claimed;
      logger.info(
        { postId: post.publicId, attemptId: attempt.id, dryRun: xClient.dryRun },
        'Publishing post',
      );

      let result: CreatePostResult;
      try {
        result = await xClient.createPost(version.text);
      } catch (error) {
        // Adapters are not supposed to throw; if one does, the outcome is unknown.
        result = {
          kind: 'unknown',
          code: 'client_exception',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const outcome = recordOutcome(post, attempt, result);
      logger.info(
        {
          postId: post.publicId,
          attemptId: attempt.id,
          outcome: outcome.result,
          code: 'code' in result ? result.code : undefined,
        },
        'Publication attempt finished',
      );
      return outcome;
    },

    retry(publicId, version) {
      return db.transaction((tx): RetryResult => {
        const record = findByPublicId(tx, publicId);
        if (!record) return { kind: 'not_found' };
        const { post } = record;
        if (post.status !== 'failed' && post.status !== 'uncertain') {
          return { kind: 'not_retryable', post: toPostView(record) };
        }
        if (post.currentVersion !== version) return { kind: 'outdated', post: toPostView(record) };

        const now = clock.now();
        const slot = scheduler.nextFreeSlot(tx, now);
        if (!slot) return { kind: 'queue_full', post: toPostView(record) };
        closeOpenAttempt(tx, post.id, false, now);
        transition(tx, post, post.status, 'scheduled', {
          scheduledAt: slot.at,
          slotKey: slot.key,
          retryCount: 0,
          lastError: null,
        });
        const updated = findByPublicId(tx, publicId);
        if (!updated) throw new Error(`Post ${publicId} disappeared`);
        return { kind: 'rescheduled', post: toPostView(updated), slot };
      }, IMMEDIATE);
    },

    markPublished(publicId, version) {
      return db.transaction((tx): MarkPublishedResult => {
        const record = findByPublicId(tx, publicId);
        if (!record) return { kind: 'not_found' };
        const { post } = record;
        if (post.status !== 'uncertain') return { kind: 'not_uncertain', post: toPostView(record) };
        if (post.currentVersion !== version) return { kind: 'outdated', post: toPostView(record) };

        const now = clock.now();
        closeOpenAttempt(tx, post.id, true, now);
        transition(tx, post, 'uncertain', 'published', { publishedAt: now, lastError: null });
        const updated = findByPublicId(tx, publicId);
        if (!updated) throw new Error(`Post ${publicId} disappeared`);
        return { kind: 'marked', post: toPostView(updated) };
      }, IMMEDIATE);
    },
  };
}
