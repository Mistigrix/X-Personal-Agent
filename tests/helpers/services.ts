import {
  type AppDatabase,
  type DatabaseHandle,
  migrateDatabase,
  openDatabase,
} from '../../src/db/client.ts';
import type { ScheduleRules } from '../../src/domain/scheduling.ts';
import type { TextRules } from '../../src/domain/text.ts';
import {
  createOutcomeNotifications,
  type OutcomeNotifications,
} from '../../src/services/outcome-notifications.ts';
import {
  createPublisherService,
  type PublisherService,
  type PublisherSettings,
} from '../../src/services/publisher-service.ts';
import { createQueueService, type QueueService } from '../../src/services/queue-service.ts';
import {
  createReconcilerService,
  type ReconcilerService,
  type ReconcileSettings,
} from '../../src/services/reconciler-service.ts';
import {
  createSchedulerService,
  type SchedulerService,
} from '../../src/services/scheduler-service.ts';
import { createXAccountResolver } from '../../src/services/x-account.ts';
import type { Clock } from '../../src/shared/clock.ts';
import { createLogger, type Logger } from '../../src/shared/logger.ts';
import {
  createFakeXClient,
  createRecordingNotifier,
  type FakeXClient,
  type RecordingNotifier,
} from './fake-x.ts';

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

export const TEST_PUBLISHER_SETTINGS: PublisherSettings = {
  maxRetries: 3,
  retryBaseDelaySeconds: 60,
};

export const TEST_RECONCILE_SETTINGS: ReconcileSettings = {
  initialDelaySeconds: 60,
  intervalSeconds: 180,
  maxChecks: 3,
  autoRetryIfNotFound: false,
};

export interface TestServices {
  handle: DatabaseHandle;
  db: AppDatabase;
  clock: TestClock;
  scheduler: SchedulerService;
  queue: QueueService;
  x: FakeXClient;
  notifier: RecordingNotifier;
  publisher: PublisherService;
  reconciler: ReconcilerService;
  notifications: OutcomeNotifications;
}

export function createTestServices(
  options: {
    databasePath?: string;
    clock?: TestClock;
    confirmPersonalPosts?: boolean;
    textRules?: Partial<TextRules>;
    schedule?: Partial<ScheduleRules>;
    maxLatenessMinutes?: number;
    publisher?: Partial<PublisherSettings>;
    reconcile?: Partial<ReconcileSettings>;
    x?: FakeXClient;
  } = {},
): TestServices {
  const handle = openDatabase(options.databasePath ?? ':memory:');
  migrateDatabase(handle);
  const db = handle.db;
  const clock = options.clock ?? createTestClock();
  const logger = silentLogger();
  const x = options.x ?? createFakeXClient();
  const notifier = createRecordingNotifier();

  const scheduler = createSchedulerService({
    db,
    rules: { ...TEST_SCHEDULE, ...options.schedule },
    maxLatenessMinutes: options.maxLatenessMinutes ?? 30,
    clock,
  });
  const queue = createQueueService({
    db,
    scheduler,
    clock,
    textRules: { ...TEST_TEXT_RULES, ...options.textRules },
    confirmPersonalPosts: options.confirmPersonalPosts ?? true,
  });
  const publisher = createPublisherService({
    db,
    xClient: x,
    scheduler,
    clock,
    logger,
    settings: { ...TEST_PUBLISHER_SETTINGS, ...options.publisher },
  });
  const reconciler = createReconcilerService({
    db,
    xClient: x,
    scheduler,
    clock,
    logger,
    settings: { ...TEST_RECONCILE_SETTINGS, ...options.reconcile },
    resolveAccount: createXAccountResolver({
      db,
      xClient: x,
      clock,
      fingerprint: 'test-credentials',
    }),
  });
  const notifications = createOutcomeNotifications({ db, notifier, clock });
  return { handle, db, clock, scheduler, queue, x, notifier, publisher, reconciler, notifications };
}

export function silentLogger(): Logger {
  return createLogger({
    level: 'silent',
    format: 'json',
    secrets: [],
    destination: { write: () => undefined },
  });
}
