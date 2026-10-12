/**
 * Behaviour configuration loaded from YAML (default: local/agent.yaml).
 * Every key is documented in config/agent.example.yaml.
 *
 * Deliberately absent: any setting that disables the explicit approval of
 * AI-generated posts. That rule is enforced in code and is not configurable.
 */
import { readFileSync } from 'node:fs';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { type ConfigIssue, fromZodError } from './issues.ts';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes since local midnight for an `HH:mm` string already validated by `localTime`. */
export function minutesOfDay(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

const localTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a 24-hour local time such as "08:30"');

const languageCode = z
  .string()
  .regex(/^[a-z]{2}$/, 'must be a two-letter ISO 639-1 language code such as "en" or "fr"');

const modelId = z.string().trim().min(1, 'must be an OpenAI model ID');

const publicationWindow = z
  .strictObject({ start: localTime, end: localTime })
  .refine((window) => minutesOfDay(window.start) < minutesOfDay(window.end), {
    message: 'start must be before end (a window cannot cross midnight)',
  });

const scheduleSchema = z
  .strictObject({
    postsPerDay: z.int().min(1).max(12).default(3),
    activeDays: z
      .array(z.enum(WEEKDAYS))
      .min(1)
      .refine((days) => new Set(days).size === days.length, 'must not contain duplicates')
      .default(() => [...WEEKDAYS]),
    windows: z
      .array(publicationWindow)
      .min(1)
      .default(() => [
        { start: '08:00', end: '09:30' },
        { start: '12:30', end: '14:00' },
        { start: '18:30', end: '20:30' },
      ]),
    minGapMinutes: z.int().min(0).max(720).default(90),
    maxLatenessMinutes: z.int().min(1).max(1440).default(30),
  })
  .superRefine((schedule, ctx) => {
    if (schedule.postsPerDay > schedule.windows.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['postsPerDay'],
        message: `${schedule.postsPerDay} posts per day need at least ${schedule.postsPerDay} publication windows, but ${schedule.windows.length} are configured`,
      });
    }
    schedule.windows.forEach((window, index) => {
      const previous = schedule.windows[index - 1];
      if (!previous) return;
      if (minutesOfDay(window.start) < minutesOfDay(previous.end)) {
        ctx.addIssue({
          code: 'custom',
          path: ['windows', index],
          message: 'windows must be listed in chronological order and must not overlap',
        });
      } else if (minutesOfDay(window.end) - minutesOfDay(previous.start) < schedule.minGapMinutes) {
        ctx.addIssue({
          code: 'custom',
          path: ['windows', index],
          message: `is too close to the previous window to keep ${schedule.minGapMinutes} minutes (minGapMinutes) between posts`,
        });
      }
    });
  });

const publishingSchema = z.strictObject({
  maxWeightedLength: z.int().min(1).max(25_000).default(280),
  urlPolicy: z.enum(['allow', 'confirm', 'block']).default('confirm'),
  requestTimeoutSeconds: z.int().min(5).max(120).default(20),
  maxRetries: z.int().min(0).max(10).default(3),
  retryBaseDelaySeconds: z.int().min(10).max(3600).default(60),
  reconcile: z
    .strictObject({
      initialDelaySeconds: z.int().min(10).max(3600).default(60),
      intervalSeconds: z.int().min(30).max(3600).default(180),
      maxChecks: z.int().min(1).max(20).default(5),
      autoRetryIfNotFound: z.boolean().default(false),
    })
    .prefault({}),
});

const telegramSchema = z.strictObject({
  confirmPersonalPosts: z.boolean().default(true),
});

const aiSchema = z.strictObject({
  enabled: z.boolean().default(true),
  models: z.strictObject({
    ideas: modelId,
    drafting: modelId,
    evaluation: modelId,
  }),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).default('medium'),
  ideasPerRequest: z.int().min(1).max(10).default(5),
  maxRegenerations: z.int().min(0).max(5).default(2),
  autoGenerate: z
    .strictObject({
      enabled: z.boolean().default(true),
      at: localTime.default('07:00'),
      maxPendingDrafts: z.int().min(1).max(20).default(3),
    })
    .prefault({}),
});

const editorialSchema = z.strictObject({
  languages: z
    .strictObject({
      default: languageCode.default('en'),
      allowed: z
        .array(languageCode)
        .min(1)
        .default(() => ['en']),
      guidance: z.string().default(''),
    })
    .prefault({})
    .refine((languages) => languages.allowed.includes(languages.default), {
      message: 'default must be one of the allowed languages',
      path: ['default'],
    }),
  contentMix: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]*$/, 'category names must be lowercase identifiers'),
      z.number().min(0),
    )
    .refine((mix) => Object.values(mix).some((weight) => weight > 0), {
      message: 'at least one category needs a weight above 0',
    })
    .default(() => ({ educational: 1, technical: 1, opinion: 1, personal: 1 })),
  topics: z
    .strictObject({
      focus: z.array(z.string().trim().min(1)).default(() => []),
      avoid: z.array(z.string().trim().min(1)).default(() => []),
    })
    .prefault({}),
  bannedPhrases: z.array(z.string().trim().min(1)).default(() => []),
  hashtags: z.strictObject({ max: z.int().min(0).max(10).default(1) }).prefault({}),
  emojis: z.strictObject({ max: z.int().min(0).max(20).default(2) }).prefault({}),
  checks: z
    .strictObject({
      lookbackPosts: z.int().min(1).max(1000).default(50),
      nearDuplicateThreshold: z.number().min(0.5).max(1).default(0.8),
      topicCooldownDays: z.int().min(0).max(60).default(3),
    })
    .prefault({}),
});

const pathsSchema = z.strictObject({
  profileDir: z.string().trim().min(1).default('./local/profile'),
  promptsDir: z.string().trim().min(1).default('./prompts'),
  promptOverridesDir: z.string().trim().min(1).default('./local/prompts'),
});

export const appConfigSchema = z.strictObject({
  configVersion: z.literal(1, { error: 'must be 1 (the only supported config format version)' }),
  timezone: z
    .string({ error: 'is required' })
    .refine(isValidTimeZone, 'must be an IANA timezone such as "Africa/Abidjan" or "Europe/Paris"'),
  schedule: scheduleSchema.prefault({}),
  publishing: publishingSchema.prefault({}),
  telegram: telegramSchema.prefault({}),
  ai: aiSchema,
  editorial: editorialSchema.prefault({}),
  paths: pathsSchema.prefault({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export type AppConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; issues: ConfigIssue[] };

/**
 * Reads and validates the YAML config file.
 * @param displayPath path shown in error messages (relative to the project root)
 */
export function loadAppConfig(filePath: string, displayPath: string): AppConfigResult {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ok: false,
      issues: [
        {
          source: displayPath,
          message: missing ? 'file not found' : 'file could not be read',
          hint: missing
            ? 'Run `pnpm init:local` to create it from config/agent.example.yaml, or set APP_CONFIG_PATH.'
            : 'Check the file permissions.',
        },
      ],
    };
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter, prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => ({
        source: displayPath,
        path: `line ${lineCounter.linePos(error.pos[0]).line}`,
        message: `YAML syntax error: ${error.message.split('\n')[0]}`,
      })),
    };
  }

  const raw: unknown = document.toJS();
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      issues: [
        {
          source: displayPath,
          message: 'file is empty',
          hint: 'Copy config/agent.example.yaml and adapt it.',
        },
      ],
    };
  }

  const result = appConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  return { ok: false, issues: fromZodError(result.error, displayPath) };
}
