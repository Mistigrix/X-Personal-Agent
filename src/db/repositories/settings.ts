import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbExecutor } from '../client.ts';
import { settings } from '../schema.ts';

/** Runtime settings persisted across restarts, with the shape of each value. */
const SETTING_SCHEMAS = {
  /** Automatic publication paused by the user (/pause). */
  publication_paused: z.boolean(),
  /** Per-install random salt that varies publication times inside windows. */
  schedule_salt: z.string().min(16),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

/** Returns the stored value, or undefined if absent or not of the expected shape. */
export function getSetting<K extends SettingKey>(
  db: DbExecutor,
  key: K,
): SettingValue<K> | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (row === undefined) return undefined;
  const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
  return parsed.success ? (parsed.data as SettingValue<K>) : undefined;
}

export function setSetting<K extends SettingKey>(
  db: DbExecutor,
  key: K,
  value: SettingValue<K>,
  now: Date,
): void {
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}
