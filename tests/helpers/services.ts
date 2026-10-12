import {
  type AppDatabase,
  type DatabaseHandle,
  migrateDatabase,
  openDatabase,
} from '../../src/db/client.ts';
import type { ScheduleRules } from '../../src/domain/scheduling.ts';
import type { TextRules } from '../../src/domain/text.ts';
import { createQueueService, type QueueService } from '../../src/services/queue-service.ts';
import {
  createSchedulerService,
  type SchedulerService,
} from '../../src/services/scheduler-service.ts';
import type { Clock } from '../../src/shared/clock.ts';

/** Monday 12 October 2026, 07:00 in Africa/Abidjan (UTC+0, no DST). */
export const MONDAY_7AM = new Date('2026-10-12T07:00:00Z');

export interface TestClock extends Clock {
  set(date: Date): void;
  advance(milliseconds: number): void;
}

export function createTestClock(initial: Date = MONDAY_7AM): TestClock {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    set: (date) => {
      current = new Date(date);
    },
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

export const TEST_SCHEDULE: ScheduleRules = {
  timezone: 'Africa/Abidjan',
  postsPerDay: 3,
  activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  windows: [
    { start: '08:00', end: '09:30' },
    { start: '12:30', end: '14:00' },
    { start: '18:30', end: '20:30' },
  ],
  minGapMinutes: 90,
};

export const TEST_TEXT_RULES: TextRules = { maxWeightedLength: 280, urlPolicy: 'confirm' };

export interface TestServices {
  handle: DatabaseHandle;
  db: AppDatabase;
  clock: TestClock;
  scheduler: SchedulerService;
  queue: QueueService;
}

export function createTestServices(
  options: {
    databasePath?: string;
    clock?: TestClock;
    confirmPersonalPosts?: boolean;
    textRules?: Partial<TextRules>;
    schedule?: Partial<ScheduleRules>;
  } = {},
): TestServices {
  const handle = openDatabase(options.databasePath ?? ':memory:');
  migrateDatabase(handle);
  const clock = options.clock ?? createTestClock();
  const scheduler = createSchedulerService({
    db: handle.db,
    rules: { ...TEST_SCHEDULE, ...options.schedule },
    clock,
  });
  const queue = createQueueService({
    db: handle.db,
    scheduler,
    clock,
    textRules: { ...TEST_TEXT_RULES, ...options.textRules },
    confirmPersonalPosts: options.confirmPersonalPosts ?? true,
  });
  return { handle, db: handle.db, clock, scheduler, queue };
}
