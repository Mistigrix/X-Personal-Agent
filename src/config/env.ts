import { z } from 'zod';
import { PUBLISH_MODES } from '../domain/publication.ts';
import { type ConfigIssue, fromZodError } from './issues.ts';

export const ENV_SOURCE = '.env';
export const DEFAULT_APP_CONFIG_PATH = './local/agent.yaml';
export const DEFAULT_DATABASE_PATH = './local/data/agent.db';

/** Empty values in `.env` (e.g. `OPENAI_API_KEY=`) mean "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalSecret = z.preprocess(
  blankToUndefined,
  z.string().min(10, 'looks too short to be a valid credential').optional(),
);

const telegramUserIds = z.string({ error: 'is required' }).transform((value, ctx) => {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const ids = parts.map(Number);
  if (parts.length === 0 || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be a comma-separated list of numeric Telegram user IDs, e.g. 123456789',
    });
    return z.NEVER;
  }
  return [...new Set(ids)];
});

export const envSchema = z.object({
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(['development', 'production', 'test']).default('production'),
  ),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  LOG_FORMAT: z.preprocess(blankToUndefined, z.enum(['json', 'pretty']).default('json')),
  APP_CONFIG_PATH: z.preprocess(blankToUndefined, z.string().default(DEFAULT_APP_CONFIG_PATH)),
  DATABASE_PATH: z.preprocess(blankToUndefined, z.string().default(DEFAULT_DATABASE_PATH)),
  PUBLISH_MODE: z.preprocess(blankToUndefined, z.enum(PUBLISH_MODES).default('dry-run')),

  TELEGRAM_BOT_TOKEN: z.preprocess(
    blankToUndefined,
    z
      .string({ error: 'is required' })
      .regex(
        /^\d{5,}:[A-Za-z0-9_-]{30,}$/,
        'does not look like a bot token (expected the "123456789:AA..." format given by @BotFather)',
      ),
  ),
  TELEGRAM_ALLOWED_USER_IDS: z.preprocess(blankToUndefined, telegramUserIds),

  OPENAI_API_KEY: optionalSecret,

  X_API_KEY: optionalSecret,
  X_API_SECRET: optionalSecret,
  X_ACCESS_TOKEN: optionalSecret,
  X_ACCESS_TOKEN_SECRET: optionalSecret,
});

export type Env = z.infer<typeof envSchema>;

export const X_CREDENTIAL_VARIABLES = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
] as const satisfies readonly (keyof Env)[];

const X_HINT =
  'Copy it from your app in the X Developer Console (Keys and tokens), or keep PUBLISH_MODE=dry-run until you have it.';

export const ENV_HINTS: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN:
    'Create a bot by messaging @BotFather on Telegram (/newbot) and paste the token it gives you.',
  TELEGRAM_ALLOWED_USER_IDS:
    'Set your own numeric Telegram user ID. Separate several IDs with commas.',
  OPENAI_API_KEY:
    'Create an API key in the OpenAI dashboard, or set ai.enabled: false in your config file.',
  PUBLISH_MODE:
    'Use dry-run while testing. Switch to live only once your X credentials are verified.',
  X_API_KEY: X_HINT,
  X_API_SECRET: X_HINT,
  X_ACCESS_TOKEN: X_HINT,
  X_ACCESS_TOKEN_SECRET: X_HINT,
};

export type EnvResult = { ok: true; env: Env } | { ok: false; issues: ConfigIssue[] };

export function parseEnv(raw: Readonly<Record<string, string | undefined>>): EnvResult {
  const result = envSchema.safeParse(raw);
  if (result.success) return { ok: true, env: result.data };
  return { ok: false, issues: fromZodError(result.error, ENV_SOURCE, ENV_HINTS) };
}

/** Credential values to scrub from every log line. */
export function collectSecrets(env: Env): string[] {
  return [
    env.TELEGRAM_BOT_TOKEN,
    env.OPENAI_API_KEY,
    env.X_API_KEY,
    env.X_API_SECRET,
    env.X_ACCESS_TOKEN,
    env.X_ACCESS_TOKEN_SECRET,
  ].filter((value): value is string => value !== undefined);
}
