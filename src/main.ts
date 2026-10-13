/**
 * Composition root: validates configuration, prepares the database and wires the
 * application. Nothing starts unless the whole configuration is valid.
 */
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { GrammyError } from 'grammy';
import { CONFIG_ERROR_EXIT_CODE, renderConfigIssues } from './config/issues.ts';
import { loadStartupConfig, toDisplayPath } from './config/load.ts';
import { migrateDatabase, openDatabase } from './db/client.ts';
import { listRecentTexts } from './db/repositories/posts.ts';
import { ALLOWED_UPDATES, BOT_COMMANDS, createBot } from './integrations/telegram/bot.ts';
import { createTelegramNotifier } from './integrations/telegram/notifier.ts';
import type { ViewContext } from './integrations/telegram/views.ts';
import { createDryRunXClient } from './integrations/x/dry-run-client.ts';
import { createLiveXClient, XRequestError } from './integrations/x/live-client.ts';
import type { XAccount, XClient } from './integrations/x/x-client.ts';
import { createAgentTasks } from './jobs/agent-tasks.ts';
import { startTicker } from './jobs/ticker.ts';
import { createDailyDrafts } from './services/daily-drafts.ts';
import { RECENT_STATUSES } from './services/editorial/editorial-service.ts';
import {
  createEditorialServiceFromConfig,
  draftRulesFromConfig,
} from './services/editorial/factory.ts';
import { createInstanceLease, type InstanceLease } from './services/instance-lease.ts';
import { createOutcomeNotifications } from './services/outcome-notifications.ts';
import { createPublisherService } from './services/publisher-service.ts';
import { createQueueService } from './services/queue-service.ts';
import { createReconcilerService } from './services/reconciler-service.ts';
import { createReviewService } from './services/review-service.ts';
import { createSchedulerService } from './services/scheduler-service.ts';
import { createXAccountResolver, credentialFingerprint } from './services/x-account.ts';
import { createBackgroundTasks } from './shared/background.ts';
import { systemClock } from './shared/clock.ts';
import { readEnvironment } from './shared/dotenv.ts';
import { createLogger, type Logger } from './shared/logger.ts';
import { waitForShutdown } from './shared/process.ts';

/** Project root, independent of the working directory the process was started from. */
const root = resolve(import.meta.dirname, '..');

const TICK_INTERVAL_MS = 30_000;
/** A lease not renewed for this long is considered abandoned (crashed instance). */
const LEASE_TTL_MS = 3 * TICK_INTERVAL_MS;
const LEASE_POLL_MS = 5_000;
/** Days of free publication slots the daily AI drafts may fill. */
const DAILY_DRAFTS_LOOKAHEAD_DAYS = 2;

async function main(): Promise<number> {
  const startup = loadStartupConfig({ root, env: readEnvironment(root) });
  if (!startup.ok) {
    process.stderr.write(renderConfigIssues(startup.issues));
    return CONFIG_ERROR_EXIT_CODE;
  }

  const { env, config, profile, paths, secrets } = startup.value;
  const logger = createLogger({ level: env.LOG_LEVEL, format: env.LOG_FORMAT, secrets });

  try {
    if (profile?.isDemo) {
      logger.warn(
        'Using the fictional demo profile (examples/profile). Generated posts will not reflect you.',
      );
    }

    const database = openDatabase(paths.databaseFile);
    migrateDatabase(database);
    const db = database.db;
    const clock = systemClock;

    const lease = createInstanceLease({ db, clock, ttlMs: LEASE_TTL_MS });
    if (!(await acquireLease(lease, logger))) {
      database.close();
      return 1;
    }

    let xClient: XClient = createDryRunXClient();
    let resolveAccount: () => Promise<XAccount> = () => xClient.getAccount();
    if (env.PUBLISH_MODE === 'live') {
      const credentials = {
        apiKey: env.X_API_KEY ?? '',
        apiSecret: env.X_API_SECRET ?? '',
        accessToken: env.X_ACCESS_TOKEN ?? '',
        accessTokenSecret: env.X_ACCESS_TOKEN_SECRET ?? '',
      };
      xClient = createLiveXClient({
        credentials,
        timeoutMs: config.publishing.requestTimeoutSeconds * 1000,
        clock,
      });
      resolveAccount = createXAccountResolver({
        db,
        xClient,
        clock,
        fingerprint: credentialFingerprint(credentials.apiKey, credentials.accessToken),
      });
      try {
        const account = await resolveAccount();
        logger.info({ account: account.username }, 'LIVE mode: posts will be published on X');
      } catch (error) {
        if (error instanceof XRequestError && error.code === 'unauthorized') {
          logger.fatal(error.message);
          lease.release();
          database.close();
          return CONFIG_ERROR_EXIT_CODE;
        }
        logger.warn({ err: error }, 'Could not verify the X account now; will retry when needed');
      }
    }

    const scheduler = createSchedulerService({
      db,
      rules: { timezone: config.timezone, ...config.schedule },
      maxLatenessMinutes: config.schedule.maxLatenessMinutes,
      clock,
    });
    const queue = createQueueService({
      db,
      scheduler,
      clock,
      textRules: {
        maxWeightedLength: config.publishing.maxWeightedLength,
        urlPolicy: config.publishing.urlPolicy,
      },
      confirmPersonalPosts: config.telegram.confirmPersonalPosts,
    });
    const publisher = createPublisherService({
      db,
      xClient,
      scheduler,
      clock,
      logger,
      settings: {
        maxRetries: config.publishing.maxRetries,
        retryBaseDelaySeconds: config.publishing.retryBaseDelaySeconds,
      },
    });
    const reconciler = createReconcilerService({
      db,
      xClient,
      scheduler,
      clock,
      logger,
      settings: config.publishing.reconcile,
      resolveAccount,
    });

    const interrupted = publisher.recoverInterrupted();
    if (interrupted > 0) {
      logger.warn(
        { attempts: interrupted },
        'Publication attempts were interrupted by the last shutdown; they will be checked against the X timeline, never resent blindly',
      );
    }

    const background = createBackgroundTasks(logger);
    const editorial = createEditorialServiceFromConfig({
      startup: startup.value,
      db,
      clock,
      logger,
      signal: background.signal,
    });
    const review = createReviewService({
      db,
      scheduler,
      clock,
      draftRules: draftRulesFromConfig(config),
      recentTexts: (executor) =>
        listRecentTexts(executor, RECENT_STATUSES, config.editorial.checks.lookbackPosts),
    });
    if (config.ai.enabled && !editorial) {
      logger.warn('AI drafting is enabled but unavailable (missing OpenAI key or profile).');
    }

    const view: ViewContext = {
      timezone: config.timezone,
      maxWeightedLength: config.publishing.maxWeightedLength,
      publishMode: env.PUBLISH_MODE,
      publishingAvailable: true,
    };
    const bot = createBot({
      token: env.TELEGRAM_BOT_TOKEN,
      allowedUserIds: env.TELEGRAM_ALLOWED_USER_IDS,
      queue,
      scheduler,
      publisher,
      review,
      editorial,
      background,
      view,
      logger,
    });

    try {
      await bot.init();
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 401) {
        logger.fatal(
          'Telegram rejected TELEGRAM_BOT_TOKEN (401 Unauthorized). Copy the token again from @BotFather.',
        );
        lease.release();
        database.close();
        return CONFIG_ERROR_EXIT_CODE;
      }
      throw error;
    }
    await bot.api
      .setMyCommands(BOT_COMMANDS)
      .catch((error: unknown) => logger.warn({ err: error }, 'Could not set the bot command menu'));

    const polling = bot
      .start({
        allowed_updates: [...ALLOWED_UPDATES],
        onStart: (info) => logger.info({ bot: info.username }, 'Telegram bot is listening'),
      })
      .then(
        () => 'Telegram polling stopped',
        (error: unknown) => {
          logPollingFailure(logger, error);
          return 'Telegram polling failed';
        },
      );

    const notifier = createTelegramNotifier({
      api: bot.api,
      recipients: env.TELEGRAM_ALLOWED_USER_IDS,
      view,
      logger,
    });
    let reportLeaseLost: (reason: string) => void = () => {};
    const leaseLost = new Promise<string>((resolveLost) => {
      reportLeaseLost = resolveLost;
    });
    const ticker = startTicker({
      intervalMs: TICK_INTERVAL_MS,
      logger,
      tasks: createAgentTasks({
        lease,
        scheduler,
        publisher,
        reconciler,
        notifications: createOutcomeNotifications({ db, notifier, clock }),
        notifier,
        logger,
        background,
        ...(editorial && config.ai.autoGenerate.enabled
          ? {
              dailyDrafts: createDailyDrafts({
                db,
                editorial,
                review,
                scheduler,
                notifier,
                clock,
                logger,
                settings: {
                  timezone: config.timezone,
                  at: config.ai.autoGenerate.at,
                  maxPendingDrafts: config.ai.autoGenerate.maxPendingDrafts,
                  lookaheadDays: DAILY_DRAFTS_LOOKAHEAD_DAYS,
                },
              }),
            }
          : {}),
        onLeaseLost: () => reportLeaseLost('publication lease lost'),
      }),
    });

    const summary = queue.summary();
    logger.info(
      {
        publishMode: env.PUBLISH_MODE,
        timezone: config.timezone,
        postsPerDay: config.schedule.postsPerDay,
        aiEnabled: config.ai.enabled,
        database: toDisplayPath(root, paths.databaseFile),
      },
      'Agent ready',
    );

    if (config.telegram.notifyOnStartup) {
      await notifier.notify({
        type: 'started',
        publishMode: env.PUBLISH_MODE,
        paused: scheduler.isPaused(),
        queued: (summary.counts.scheduled ?? 0) + (summary.counts.pending_confirmation ?? 0),
      });
    }

    const reason = await waitForShutdown(Promise.race([polling, leaseLost]));
    logger.info({ reason }, 'Shutting down');
    // Let an in-flight publication finish recording its outcome before closing.
    await ticker.stop();
    // Model calls in progress are cancelled: nothing they produce is lost but a draft.
    await background.stop();
    if (bot.isRunning()) await bot.stop();
    lease.release();
    database.close();
    return reason === 'SIGINT' || reason === 'SIGTERM' ? 0 : 1;
  } catch (error) {
    logger.fatal({ err: error }, 'Agent stopped after an unexpected error');
    return 1;
  }
}

/**
 * Takes the publication lease. Right after a crash the previous lease may still
 * be valid for a short while, so wait for it to expire before giving up.
 */
async function acquireLease(lease: InstanceLease, logger: Logger): Promise<boolean> {
  const deadline = Date.now() + LEASE_TTL_MS + LEASE_POLL_MS;
  for (;;) {
    const result = lease.tryAcquire();
    if (result.acquired) return true;
    if (Date.now() > deadline) {
      logger.fatal(
        'Another agent instance is running with this database. Stop it before starting a new one.',
      );
      return false;
    }
    logger.warn(
      { heldUntil: result.heldUntil.toISOString() },
      'Another instance holds the publication lease (normal right after a crash); waiting for it to expire',
    );
    await sleep(LEASE_POLL_MS);
  }
}

function logPollingFailure(logger: Logger, error: unknown): void {
  if (error instanceof GrammyError && error.error_code === 409) {
    logger.fatal(
      'Another process is already receiving updates for this bot (409 Conflict). Stop it (another agent instance or `pnpm telegram:whoami`) and start again.',
    );
    return;
  }
  logger.fatal({ err: error }, 'Telegram polling failed');
}

process.exitCode = await main();
