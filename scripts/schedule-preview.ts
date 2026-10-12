/**
 * Shows the upcoming publication slots and the posts assigned to them, without
 * changing anything (only the per-install schedule salt is created if missing).
 * Usage: pnpm schedule:preview [days]   (default 7)
 */
import { resolve } from 'node:path';
import { loadAppConfig } from '../src/config/app-config.ts';
import { DEFAULT_APP_CONFIG_PATH, DEFAULT_DATABASE_PATH } from '../src/config/env.ts';
import { renderConfigIssues } from '../src/config/issues.ts';
import { migrateDatabase, openDatabase } from '../src/db/client.ts';
import { listByStatuses } from '../src/db/repositories/posts.ts';
import { QUEUE_STATUSES } from '../src/domain/post.ts';
import { formatLocalTime } from '../src/integrations/telegram/views.ts';
import { createSchedulerService } from '../src/services/scheduler-service.ts';
import { systemClock } from '../src/shared/clock.ts';
import { readEnvironment } from '../src/shared/dotenv.ts';

const root = resolve(import.meta.dirname, '..');
const env = readEnvironment(root);
const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1 || days > 90) {
  console.error('Usage: pnpm schedule:preview [days]   (1 to 90, default 7)');
  process.exit(2);
}

const configPath = resolve(root, env.APP_CONFIG_PATH || DEFAULT_APP_CONFIG_PATH);
const configResult = loadAppConfig(configPath, configPath);
if (!configResult.ok) {
  process.stderr.write(renderConfigIssues(configResult.issues));
  process.exit(78);
}
const { config } = configResult;

const database = openDatabase(resolve(root, env.DATABASE_PATH || DEFAULT_DATABASE_PATH));
migrateDatabase(database);
const scheduler = createSchedulerService({
  db: database.db,
  rules: { timezone: config.timezone, ...config.schedule },
  maxLatenessMinutes: config.schedule.maxLatenessMinutes,
  clock: systemClock,
});

const posts = listByStatuses(database.db, QUEUE_STATUSES, 1000);
const bySlot = new Map(
  posts.flatMap((record) => (record.post.slotKey ? [[record.post.slotKey, record]] : [])),
);
const snippet = (text: string) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 50 ? `${line.slice(0, 50)}…` : line;
};

console.log(`Publication slots for the next ${days} day(s), times in ${config.timezone}`);
console.log(scheduler.isPaused() ? 'Publication is PAUSED.\n' : '');
for (const slot of scheduler.upcoming(days)) {
  const record = bySlot.get(slot.key);
  const when = formatLocalTime(slot.at, config.timezone);
  console.log(
    record
      ? `${when}  ${record.post.publicId}  ${record.post.status.padEnd(9)}  ${snippet(record.version.text)}`
      : `${when}  ------  free`,
  );
}

const elsewhere = posts.filter(
  ({ post }) =>
    post.status !== 'scheduled' || (post.scheduledAt && post.slotKey && !bySlot.has(post.slotKey)),
);
if (elsewhere.length > 0) {
  console.log('\nOther posts in the queue:');
  for (const { post, version } of elsewhere) {
    const when = post.scheduledAt ? formatLocalTime(post.scheduledAt, config.timezone) : 'no time';
    console.log(`${post.publicId}  ${post.status}  ${when}  ${snippet(version.text)}`);
  }
}
database.close();
