/**
 * Composition root: validates configuration, prepares the database and wires the
 * application. Nothing starts unless the whole configuration is valid.
 */
import { resolve } from 'node:path';
import { CONFIG_ERROR_EXIT_CODE, renderConfigIssues } from './config/issues.ts';
import { loadStartupConfig, toDisplayPath } from './config/load.ts';
import { migrateDatabase, openDatabase } from './db/client.ts';
import { readEnvironment } from './shared/dotenv.ts';
import { createLogger } from './shared/logger.ts';
import { waitForShutdownSignal } from './shared/process.ts';

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

    logger.info(
      {
        publishMode: env.PUBLISH_MODE,
        timezone: config.timezone,
        postsPerDay: config.schedule.postsPerDay,
        aiEnabled: config.ai.enabled,
        database: toDisplayPath(root, paths.databaseFile),
      },
      'Agent ready. No background jobs yet (Milestone 1); press Ctrl+C to stop.',
    );

    const signal = await waitForShutdownSignal();
    logger.info({ signal }, 'Shutting down');
    database.close();
    return 0;
  } catch (error) {
    logger.fatal({ err: error }, 'Agent stopped after an unexpected error');
    return 1;
  }
}

process.exitCode = await main();
