/**
 * Delivers publication outcomes to the user. Outcomes are read from the
 * attempts table (`notified_at IS NULL`), so a notification that could not be
 * delivered (Telegram down, process restart) is sent on a later tick.
 */
import type { AppDatabase } from '../db/client.ts';
import {
  type AttemptRecord,
  listUnnotifiedAttempts,
  markAttemptNotified,
} from '../db/repositories/attempts.ts';
import { RESOLVED_BY_USER } from '../domain/publication.ts';
import type { Clock } from '../shared/clock.ts';
import type { AgentEvent, Notifier } from './notifier.ts';

/** Minimum delay before retrying a notification that could not be delivered. */
const REDELIVERY_DELAY_MS = 5 * 60 * 1000;

export interface OutcomeNotifications {
  /** Sends pending outcome notifications. Returns how many were delivered. */
  dispatch(): Promise<number>;
}

export function outcomeEvent({ attempt, post, version }: AttemptRecord): AgentEvent | null {
  if (attempt.errorCode === RESOLVED_BY_USER) return null;
  const eventPost = { publicId: post.publicId, version: post.currentVersion, text: version.text };
  switch (attempt.status) {
    case 'succeeded':
      return {
        type: 'published',
        post: eventPost,
        xPostId: attempt.xPostId,
        dryRun: attempt.dryRun,
      };
    case 'failed_permanent':
    case 'failed_retryable':
      // Transient failures with retries left are silent; only a final failure is reported.
      return post.status === 'failed'
        ? {
            type: 'publication_failed',
            post: eventPost,
            reason: attempt.errorMessage ?? 'Unknown error.',
          }
        : null;
    case 'unknown':
      return { type: 'publication_uncertain', post: eventPost, reason: attempt.errorMessage ?? '' };
    case 'reconciled_found':
      return { type: 'publication_confirmed', post: eventPost, xPostId: attempt.xPostId };
    case 'reconciled_not_found':
      return {
        type: 'publication_not_found',
        post: eventPost,
        reason: attempt.errorMessage,
        rescheduledAt: post.status === 'scheduled' ? post.scheduledAt : null,
      };
    case 'in_flight':
      return null;
  }
}

export function createOutcomeNotifications(deps: {
  db: AppDatabase;
  notifier: Notifier;
  clock: Clock;
}): OutcomeNotifications {
  const { db, notifier, clock } = deps;
  const nextAttemptAt = new Map<number, number>();

  return {
    async dispatch() {
      let delivered = 0;
      for (const record of listUnnotifiedAttempts(db)) {
        const id = record.attempt.id;
        if ((nextAttemptAt.get(id) ?? 0) > clock.now().getTime()) continue;

        const event = outcomeEvent(record);
        if (event === null || (await notifier.notify(event))) {
          markAttemptNotified(db, id, clock.now());
          nextAttemptAt.delete(id);
          if (event !== null) delivered += 1;
        } else {
          nextAttemptAt.set(id, clock.now().getTime() + REDELIVERY_DELAY_MS);
        }
      }
      return delivered;
    },
  };
}
