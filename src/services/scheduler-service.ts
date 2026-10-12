import { randomBytes } from 'node:crypto';
import type { AppDatabase, DbExecutor } from '../db/client.ts';
import { takenSlotKeys } from '../db/repositories/posts.ts';
import { getSetting, setSetting } from '../db/repositories/settings.ts';
import { findNextFreeSlot, type ScheduleRules, type Slot } from '../domain/scheduling.ts';
import type { Clock } from '../shared/clock.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SchedulerService {
  /**
   * Earliest free slot strictly after `after`. Call it inside the transaction
   * that books the slot, so two posts cannot be given the same one.
   */
  nextFreeSlot(db: DbExecutor, after: Date): Slot | null;
  isPaused(): boolean;
  /** Pauses automatic publication. Returns false if it was already paused. */
  pause(): boolean;
  /** Resumes automatic publication. Returns false if it was not paused. */
  resume(): boolean;
}

export function createSchedulerService(deps: {
  db: AppDatabase;
  rules: ScheduleRules;
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
    nextFreeSlot(executor, after) {
      // Posts holding upcoming slots are scheduled after `after`; the margin also
      // covers posts whose retry time moved past their original slot.
      const taken = takenSlotKeys(executor, new Date(after.getTime() - DAY_MS));
      return findNextFreeSlot(after, taken, rules, scheduleSalt(executor));
    },
    isPaused: () => getSetting(db, 'publication_paused') ?? false,
    pause: () => setPaused(true),
    resume: () => setPaused(false),
  };
}
