/** Shared start-up for CLI scripts: validated configuration, database, quiet logger. */
import { resolve } from 'node:path';
import { CONFIG_ERROR_EXIT_CODE, renderConfigIssues } from '../../src/config/issues.ts';
import { loadStartupConfig, type StartupConfig } from '../../src/config/load.ts';
import { type DatabaseHandle, migrateDatabase, openDatabase } from '../../src/db/client.ts';
import { readEnvironment } from '../../src/shared/dotenv.ts';
import { createLogger, type Logger } from '../../src/shared/logger.ts';

export interface ScriptContext {
  startup: StartupConfig;
  database: DatabaseHandle;
  logger: Logger;
}

export function bootstrap(): ScriptContext {
  const root = resolve(import.meta.dirname, '..', '..');
  const startup = loadStartupConfig({ root, env: readEnvironment(root) });
  if (!startup.ok) {
    process.stderr.write(renderConfigIssues(startup.issues));
    process.exit(CONFIG_ERROR_EXIT_CODE);
  }
  const database = openDatabase(startup.value.paths.databaseFile);
  migrateDatabase(database);
  // Scripts print their own output; only problems are logged.
  const logger = createLogger({
    level: 'warn',
    format: startup.value.env.LOG_FORMAT,
    secrets: startup.value.secrets,
  });
  return { startup: startup.value, database, logger };
}

export function formatUsage(usage: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): string {
  const n = (value: number) => value.toLocaleString('en-US');
  return `Tokens: ${n(usage.inputTokens)} input (${n(usage.cachedInputTokens)} cached), ${n(usage.outputTokens)} output`;
}
