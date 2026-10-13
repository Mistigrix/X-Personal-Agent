import { randomBytes } from 'node:crypto';
import type { AppDatabase, DbExecutor } from '../db/client.ts';
import { listOverdueScheduled, takenSlotKeys, updatePost } from '../db/repositories/posts.ts';
import { getSetting, setSetting } from '../db/repositories/settings.ts';
import { assertTransition } from '../domain/post.ts';
import {
  findNextFreeSlot,
  type ScheduleRules,
  type Slot,
  upcomingSlots,
} from '../domain/scheduling.ts';
import type { Clock } from '../shared/clock.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RescheduledPost {
  publicId: string;
  from: Date | null;
  to: Date;
}

export interface SchedulerService {
  /**
   * Earliest free slot strictly after `after`. Call it inside the transaction
   * that books the slot, so two posts cannot be given the same one.
   */
  nextFreeSlot(db: DbExecutor, after: Date): Slot | null;
  /**
   * Moves posts that missed their time by more than `maxLatenessMinutes` (pause,
   * downtime) to the next free slots, in order, instead of publishing them late
   * in a burst.
   */
  rescheduleOverdue(): RescheduledPost[];
  /** Publication slots in the next `days` local days (taken or not). */
  upcoming(days: number): Slot[];
  /** Number of free publication slots in the next `days` local days. */
  freeSlotCount(days: number): number;
  isPaused(): boolean;
  /** Pauses automatic publication. Returns false if it was already paused. */
  pause(): boolean;
  /** Resumes automatic publication. Returns false if it was not paused. */
  resume(): boolean;
}

export function createSchedulerService(deps: {
  db: AppDatabase;
  rules: ScheduleRules;
  maxLatenessMinutes: number;
  clock: Clock;
}): SchedulerService {
  const { db, rules, clock } = deps;

  function scheduleSalt(executor: DbExecutor): string {
    const existing = getSetting(executor, 'schedule_salt');
    if (existing !== undefined) return existing;
    const salt = randomBytes(16).toString('hex');
    setSetting(executor, 'schedule_salt', salt, clock.now());
    return salt;
  }

  function nextFreeSlot(executor: DbExecutor, after: Date): Slot | null {
    // Posts holding upcoming slots are scheduled after `after`; the margin also
    // covers posts whose retry time moved past their original slot.
    const taken = takenSlotKeys(executor, new Date(after.getTime() - DAY_MS));
    return findNextFreeSlot(after, taken, rules, scheduleSalt(executor));
  }

  function setPaused(paused: boolean): boolean {
    return db.transaction(
      (tx) => {
        if ((getSetting(tx, 'publication_paused') ?? false) === paused) return false;
        setSetting(tx, 'publication_paused', paused, clock.now());
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  return {
    nextFreeSlot,

    rescheduleOverdue() {
      return db.transaction(
        (tx) => {
          const now = clock.now();
          const overdue = listOverdueScheduled(
            tx,
            new Date(now.getTime() - deps.maxLatenessMinutes * 60_000),
          );
          const moves: RescheduledPost[] = [];
          for (const post of overdue) {
            const slot = nextFreeSlot(tx, now);
            if (!slot) break;
            assertTransition(post.source, 'scheduled', 'scheduled');
            updatePost(tx, post.id, 'scheduled', {
              scheduledAt: slot.at,
              slotKey: slot.key,
              updatedAt: now,
            });
            moves.push({ publicId: post.publicId, from: post.scheduledAt, to: slot.at });
          }
          return moves;
        },
        { behavior: 'immediate' },
      );
    },

    upcoming(days) {
      return [...upcomingSlots(clock.now(), rules, scheduleSalt(db), days)];
    },

    freeSlotCount(days) {
      const now = clock.now();
      const taken = takenSlotKeys(db, new Date(now.getTime() - DAY_MS));
      return [...upcomingSlots(now, rules, scheduleSalt(db), days)].filter(
        (slot) => !taken.has(slot.key),
      ).length;
    },

    isPaused: () => getSetting(db, 'publication_paused') ?? false,
    pause: () => setPaused(true),
    resume: () => setPaused(false),
  };
}
