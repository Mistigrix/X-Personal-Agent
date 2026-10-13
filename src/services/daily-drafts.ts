/**
 * Once a day, after `ai.autoGenerate.at` (local time), prepares AI drafts for
 * review. Only as many as there are free slots ahead and room under
 * `maxPendingDrafts`: no filler, and never more drafts than the author can use.
 * Drafts are only proposed; publishing still needs the author's approval.
 */
import { DateTime } from 'luxon';
import type { AppDatabase } from '../db/client.ts';
import { finishJobRun, jobRunExists, tryStartJobRun } from '../db/repositories/job-runs.ts';
import { countAiPosts } from '../db/repositories/posts.ts';
import { minutesOfDay } from '../domain/scheduling.ts';
import type { Clock } from '../shared/clock.ts';
import type { Logger } from '../shared/logger.ts';
import type { EditorialService } from './editorial/editorial-service.ts';
import type { Notifier } from './notifier.ts';
import type { ReviewService } from './review-service.ts';
import type { SchedulerService } from './scheduler-service.ts';

export const DAILY_DRAFTS_JOB = 'daily-drafts';

export interface DailyDraftsSettings {
  timezone: string;
  /** Local time, `HH:mm`. */
  at: string;
  maxPendingDrafts: number;
  /** Days of free slots to fill. */
  lookaheadDays: number;
}

export type DailyDraftsOutcome =
  | { kind: 'skipped'; reason: 'not_due' | 'already_ran' }
  | { kind: 'nothing_needed'; pending: number; freeSlots: number }
  | { kind: 'done'; created: number }
  | { kind: 'failed'; message: string };

export interface DailyDrafts {
  runIfDue(): Promise<DailyDraftsOutcome>;
}

export function createDailyDrafts(deps: {
  db: AppDatabase;
  editorial: EditorialService;
  review: ReviewService;
  scheduler: SchedulerService;
  notifier: Notifier;
  clock: Clock;
  logger: Logger;
  settings: DailyDraftsSettings;
}): DailyDrafts {
  const { db, editorial, review, scheduler, notifier, clock, logger, settings } = deps;

  return {
    async runIfDue() {
      const now = clock.now();
      const local = DateTime.fromJSDate(now, { zone: settings.timezone });
      if (local.hour * 60 + local.minute < minutesOfDay(settings.at)) {
        return { kind: 'skipped', reason: 'not_due' };
      }
      const runKey = local.toISODate() ?? '';
      if (jobRunExists(db, DAILY_DRAFTS_JOB, runKey))
        return { kind: 'skipped', reason: 'already_ran' };
      const jobId = tryStartJobRun(db, { jobName: DAILY_DRAFTS_JOB, runKey, now });
      if (jobId === null) return { kind: 'skipped', reason: 'already_ran' };

      try {
        const pending = countAiPosts(db, 'draft');
        const freeSlots = scheduler.freeSlotCount(settings.lookaheadDays);
        const wanted = Math.min(settings.maxPendingDrafts - pending, freeSlots);
        if (wanted <= 0) {
          finishJobRun(db, jobId, {
            status: 'succeeded',
            now: clock.now(),
            meta: { pending, freeSlots, created: 0 },
          });
          return { kind: 'nothing_needed', pending, freeSlots };
        }

        const ideas = await editorial.generateIdeas(wanted);
        if (ideas.kind === 'error') {
          finishJobRun(db, jobId, { status: 'failed', now: clock.now(), error: ideas.message });
          await notifier.notify({
            type: 'editorial_error',
            message: `Daily drafts: ${ideas.message}`,
          });
          return { kind: 'failed', message: ideas.message };
        }

        let created = 0;
        for (const idea of ideas.ideas) {
          const result = await editorial.draftFromIdea(idea.publicId);
          if (result.kind !== 'drafted') continue;
          created += 1;
          const card = review.card(result.post.publicId);
          if (card) await notifier.notify({ type: 'draft_ready', card });
        }
        finishJobRun(db, jobId, {
          status: 'succeeded',
          now: clock.now(),
          meta: { pending, freeSlots, ideas: ideas.ideas.length, created },
        });
        logger.info({ created, pending, freeSlots }, 'Daily drafts prepared');
        return { kind: 'done', created };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finishJobRun(db, jobId, { status: 'failed', now: clock.now(), error: message });
        throw error;
      }
    },
  };
}
