/**
 * Resolves uncertain publications by looking for the post on the account's own
 * timeline (owned reads, billed per post returned). Never resends anything: if
 * the post is not found, the user decides (unless autoRetryIfNotFound is set).
 */
import type { AppDatabase, DbExecutor } from '../db/client.ts';
import {
  type AttemptRecord,
  listAttemptsByStatus,
  updateAttempt,
} from '../db/repositories/attempts.ts';
import { type PostChanges, updatePost, xPostIdExists } from '../db/repositories/posts.ts';
import { assertTransition, type PostStatus } from '../domain/post.ts';
import { isSamePost, RECONCILIATION_LOOKBACK_MS } from '../domain/reconciliation.ts';
import type { ListPostsResult, XAccount, XClient } from '../integrations/x/x-client.ts';
import type { Clock } from '../shared/clock.ts';
import type { Logger } from '../shared/logger.ts';
import type { SchedulerService } from './scheduler-service.ts';

export interface ReconcileSettings {
  initialDelaySeconds: number;
  intervalSeconds: number;
  maxChecks: number;
  autoRetryIfNotFound: boolean;
}

export interface ReconcilerService {
  /** Checks every uncertain attempt that is due for a check. Returns how many were checked. */
  reconcile(): Promise<number>;
}

const IMMEDIATE = { behavior: 'immediate' } as const;

export function createReconcilerService(deps: {
  db: AppDatabase;
  xClient: XClient;
  scheduler: SchedulerService;
  clock: Clock;
  logger: Logger;
  settings: ReconcileSettings;
  /** The authenticated X account (cached; a paid lookup only when unknown). */
  resolveAccount: () => Promise<XAccount>;
}): ReconcilerService {
  const { db, xClient, scheduler, clock, logger, settings } = deps;

  function isDue({ attempt }: AttemptRecord, now: number): boolean {
    if (attempt.startedAt.getTime() + settings.initialDelaySeconds * 1000 > now) return false;
    const last = attempt.lastReconciledAt?.getTime();
    return last === undefined || last + settings.intervalSeconds * 1000 <= now;
  }

  async function accountId(): Promise<string | null> {
    try {
      return (await deps.resolveAccount()).id;
    } catch (error) {
      logger.warn({ err: error }, 'Could not identify the X account for reconciliation');
      return null;
    }
  }

  function movePost(
    tx: DbExecutor,
    record: AttemptRecord,
    to: PostStatus,
    changes: Omit<PostChanges, 'status' | 'updatedAt'>,
  ): void {
    const { post } = record;
    assertTransition(post.source, 'uncertain', to);
    updatePost(tx, post.id, 'uncertain', { ...changes, status: to, updatedAt: clock.now() });
  }

  /** Nothing is ever sent in dry-run mode, so an interrupted dry-run attempt is simply rescheduled. */
  function resolveDryRun(record: AttemptRecord): void {
    db.transaction((tx) => {
      const now = clock.now();
      const closed = updateAttempt(tx, record.attempt.id, 'unknown', {
        status: 'reconciled_not_found',
        lastReconciledAt: now,
        notifiedAt: now,
      });
      if (!closed || record.post.status !== 'uncertain') return;
      const slot = scheduler.nextFreeSlot(tx, now);
      if (slot) {
        movePost(tx, record, 'scheduled', {
          scheduledAt: slot.at,
          slotKey: slot.key,
          lastError: null,
        });
      }
    }, IMMEDIATE);
  }

  function applyCheck(record: AttemptRecord, result: ListPostsResult): void {
    db.transaction((tx) => {
      const now = clock.now();
      const { attempt, version, post } = record;
      const checks = attempt.reconcileChecks + 1;

      const match =
        result.kind === 'ok'
          ? result.posts.find(
              (remote) => isSamePost(version.text, remote.text) && !xPostIdExists(tx, remote.id),
            )
          : undefined;

      if (match) {
        if (
          !updateAttempt(tx, attempt.id, 'unknown', {
            status: 'reconciled_found',
            xPostId: match.id,
            reconcileChecks: checks,
            lastReconciledAt: now,
            notifiedAt: null,
          })
        )
          return;
        if (post.status === 'uncertain') {
          movePost(tx, record, 'published', {
            publishedAt: attempt.startedAt,
            xPostId: match.id,
            lastError: null,
          });
        }
        logger.info(
          { postId: post.publicId, xPostId: match.id },
          'Uncertain publication confirmed on X',
        );
        return;
      }

      const lastError =
        result.kind === 'error' ? `Timeline check failed: ${result.message}` : attempt.errorMessage;
      if (checks < settings.maxChecks) {
        updateAttempt(tx, attempt.id, 'unknown', {
          reconcileChecks: checks,
          lastReconciledAt: now,
          errorMessage: lastError,
        });
        return;
      }

      if (
        !updateAttempt(tx, attempt.id, 'unknown', {
          status: 'reconciled_not_found',
          reconcileChecks: checks,
          lastReconciledAt: now,
          errorMessage: lastError,
          notifiedAt: null,
        })
      )
        return;
      logger.warn({ postId: post.publicId, checks }, 'Uncertain publication not found on X');

      // Automatic retry only after a successful read found nothing, and never when
      // X reported duplicate content (the post most likely exists).
      const autoRetry =
        settings.autoRetryIfNotFound &&
        result.kind === 'ok' &&
        attempt.errorCode !== 'duplicate_content' &&
        post.status === 'uncertain';
      if (autoRetry) {
        const slot = scheduler.nextFreeSlot(tx, now);
        if (slot) {
          movePost(tx, record, 'scheduled', {
            scheduledAt: slot.at,
            slotKey: slot.key,
            retryCount: post.retryCount + 1,
            lastError: 'Not found on X after an uncertain attempt; rescheduled automatically.',
          });
        }
      }
    }, IMMEDIATE);
  }

  return {
    async reconcile() {
      const now = clock.now().getTime();
      const due = listAttemptsByStatus(db, 'unknown').filter((record) => isDue(record, now));
      if (due.length === 0) return 0;

      for (const record of due) {
        if (record.attempt.dryRun) {
          resolveDryRun(record);
          continue;
        }
        const userId = await accountId();
        const result: ListPostsResult = userId
          ? await xClient.listOwnPostsSince(
              userId,
              new Date(record.attempt.startedAt.getTime() - RECONCILIATION_LOOKBACK_MS),
            )
          : {
              kind: 'error',
              code: 'unknown_account',
              message: 'the X account could not be identified',
            };
        applyCheck(record, result);
      }
      return due.length;
    },
  };
}
