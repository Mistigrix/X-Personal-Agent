/**
 * Composition root: validates configuration, prepares the database and wires the
 * application. Nothing starts unless the whole configuration is valid.
 */
import { resolve } from 'node:path';
import { GrammyError } from 'grammy';
import { CONFIG_ERROR_EXIT_CODE, renderConfigIssues } from './config/issues.ts';
import { loadStartupConfig, toDisplayPath } from './config/load.ts';
import { migrateDatabase, openDatabase } from './db/client.ts';
import { ALLOWED_UPDATES, BOT_COMMANDS, createBot } from './integrations/telegram/bot.ts';
import { createTelegramNotifier } from './integrations/telegram/notifier.ts';
import type { ViewContext } from './integrations/telegram/views.ts';
import { createQueueService } from './services/queue-service.ts';
import { createSchedulerService } from './services/scheduler-service.ts';
import { systemClock } from './shared/clock.ts';
import { readEnvironment } from './shared/dotenv.ts';
import { createLogger, type Logger } from './shared/logger.ts';
import { waitForShutdown } from './shared/process.ts';

/** Project root, independent of the working directory the process was started from. */
const root = resolve(import.meta.dirname, '..');

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

    const clock = systemClock;
    const scheduler = createSchedulerService({
      db: database.db,
      rules: { timezone: config.timezone, ...config.schedule },
      clock,
    });
    const queue = createQueueService({
      db: database.db,
      scheduler,
      clock,
      textRules: {
        maxWeightedLength: config.publishing.maxWeightedLength,
        urlPolicy: config.publishing.urlPolicy,
      },
      confirmPersonalPosts: config.telegram.confirmPersonalPosts,
    });

    const view: ViewContext = {
      timezone: config.timezone,
      maxWeightedLength: config.publishing.maxWeightedLength,
      publishMode: env.PUBLISH_MODE,
      publishingAvailable: false,
    };
    const bot = createBot({
      token: env.TELEGRAM_BOT_TOKEN,
      allowedUserIds: env.TELEGRAM_ALLOWED_USER_IDS,
      queue,
      scheduler,
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

    const summary = queue.summary();
    logger.info(
      {
        publishMode: env.PUBLISH_MODE,
        timezone: config.timezone,
        postsPerDay: config.schedule.postsPerDay,
        aiEnabled: config.ai.enabled,
        database: toDisplayPath(root, paths.databaseFile),
      },
      'Agent ready. Automatic publishing is not implemented yet (Milestone 3).',
    );

    if (config.telegram.notifyOnStartup) {
      const notifier = createTelegramNotifier({
        api: bot.api,
        recipients: env.TELEGRAM_ALLOWED_USER_IDS,
        view,
        logger,
      });
      await notifier.notify({
        type: 'started',
        publishMode: env.PUBLISH_MODE,
        paused: scheduler.isPaused(),
        queued: (summary.counts.scheduled ?? 0) + (summary.counts.pending_confirmation ?? 0),
      });
    }

    const reason = await waitForShutdown(polling);
    logger.info({ reason }, 'Shutting down');
    if (bot.isRunning()) await bot.stop();
    database.close();
    return reason === 'SIGINT' || reason === 'SIGTERM' ? 0 : 1;
  } catch (error) {
    logger.fatal({ err: error }, 'Agent stopped after an unexpected error');
    return 1;
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
