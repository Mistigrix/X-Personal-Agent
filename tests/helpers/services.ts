import { join } from 'node:path';
import { loadProfile } from '../../src/config/profile.ts';
import {
  type AppDatabase,
  type DatabaseHandle,
  migrateDatabase,
  openDatabase,
} from '../../src/db/client.ts';
import { listRecentTexts } from '../../src/db/repositories/posts.ts';
import type { DraftRules } from '../../src/domain/editorial/checks.ts';
import { buildProfileContext } from '../../src/domain/editorial/profile-context.ts';
import type { ScheduleRules } from '../../src/domain/scheduling.ts';
import type { TextRules } from '../../src/domain/text.ts';
import {
  createEditorialService,
  type EditorialService,
  type EditorialSettings,
  RECENT_STATUSES,
} from '../../src/services/editorial/editorial-service.ts';
import { createPromptTemplates } from '../../src/services/editorial/prompts.ts';
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
import { createReviewService, type ReviewService } from '../../src/services/review-service.ts';
import {
  createSchedulerService,
  type SchedulerService,
} from '../../src/services/scheduler-service.ts';
import { createXAccountResolver } from '../../src/services/x-account.ts';
import { type BackgroundTasks, createBackgroundTasks } from '../../src/shared/background.ts';
import type { Clock } from '../../src/shared/clock.ts';
import { createLogger, type Logger } from '../../src/shared/logger.ts';
import { createFakeLlm, type FakeLlm } from './fake-llm.ts';
import {
  createFakeXClient,
  createRecordingNotifier,
  type FakeXClient,
  type RecordingNotifier,
} from './fake-x.ts';
import { REPO_ROOT } from './fixtures.ts';

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

export const TEST_DRAFT_RULES: DraftRules = {
  text: TEST_TEXT_RULES,
  bannedPhrases: ['game-changer'],
  maxHashtags: 1,
  maxEmojis: 2,
  allowedLanguages: ['en', 'fr'],
  avoidTopics: ['politics'],
  nearDuplicateThreshold: 0.8,
};

export const TEST_EDITORIAL_SETTINGS: EditorialSettings = {
  ideasPerRequest: 3,
  maxRegenerations: 2,
  contentMix: { technical: 1, opinion: 1 },
  topicsFocus: [],
  defaultLanguage: 'en',
  languageGuidance: '',
  lookbackPosts: 50,
  topicCooldownDays: 3,
  draftRules: TEST_DRAFT_RULES,
};

/** Profile context built from the bundled fictional demo profile. */
export function demoProfileContext(): string {
  const result = loadProfile(join(REPO_ROOT, 'examples/profile'), 'examples/profile', true);
  if (!result.ok) throw new Error('The demo profile should load');
  return buildProfileContext(result.profile.sections);
}

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
  llm: FakeLlm;
  editorial: EditorialService;
  review: ReviewService;
  background: BackgroundTasks;
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
  const background = createBackgroundTasks(logger);
  const llm = createFakeLlm();
  const editorial = createEditorialService({
    db,
    llm,
    prompts: createPromptTemplates({
      promptsDir: join(REPO_ROOT, 'prompts'),
      overridesDir: join(REPO_ROOT, 'no-overrides'),
    }),
    profile: demoProfileContext(),
    clock,
    logger,
    settings: TEST_EDITORIAL_SETTINGS,
    signal: background.signal,
  });
  const review = createReviewService({
    db,
    scheduler,
    clock,
    draftRules: TEST_DRAFT_RULES,
    recentTexts: (executor) => listRecentTexts(executor, RECENT_STATUSES, 50),
  });
  return {
    handle,
    db,
    clock,
    scheduler,
    queue,
    x,
    notifier,
    publisher,
    reconciler,
    notifications,
    llm,
    editorial,
    review,
    background,
  };
}

export function silentLogger(): Logger {
  return createLogger({
    level: 'silent',
    format: 'json',
    secrets: [],
    destination: { write: () => undefined },
  });
}
