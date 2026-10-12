import { describe, expect, it } from 'vitest';
import {
  fakeOpenAiKey,
  fakeTelegramToken,
  fakeXCredential,
  validEnv,
} from '../../tests/helpers/fixtures.ts';
import { collectSecrets, parseEnv } from './env.ts';

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    const result = parseEnv(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.PUBLISH_MODE).toBe('dry-run');
    expect(result.env.LOG_FORMAT).toBe('json');
    expect(result.env.APP_CONFIG_PATH).toBe('./local/agent.yaml');
    expect(result.env.DATABASE_PATH).toBe('./local/data/agent.db');
  });

  it('treats blank values as not set', () => {
    const result = parseEnv(validEnv({ OPENAI_API_KEY: '', PUBLISH_MODE: '  ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.env.PUBLISH_MODE).toBe('dry-run');
  });

  it('parses and deduplicates allowed Telegram user IDs', () => {
    const result = parseEnv(validEnv({ TELEGRAM_ALLOWED_USER_IDS: '111, 222,111' }));
    expect(result.ok && result.env.TELEGRAM_ALLOWED_USER_IDS).toEqual([111, 222]);
  });

  it.each(['abc', '12,-5', '1.5', ','])('rejects invalid user ID list %j', (value) => {
    const result = parseEnv(validEnv({ TELEGRAM_ALLOWED_USER_IDS: value }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({ source: '.env', path: 'TELEGRAM_ALLOWED_USER_IDS' }),
    ]);
  });

  it('reports every missing required variable with a fix hint', () => {
    const result = parseEnv({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_ALLOWED_USER_IDS',
    ]);
    expect(result.issues.every((issue) => issue.hint)).toBe(true);
  });

  it('never echoes a malformed secret in the error message', () => {
    const malformed = `not-a-token-${'s'.repeat(20)}`;
    const result = parseEnv(validEnv({ TELEGRAM_BOT_TOKEN: malformed }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(malformed);
  });

  it('rejects an unknown publish mode', () => {
    const result = parseEnv(validEnv({ PUBLISH_MODE: 'yolo' }));
    expect(result.ok).toBe(false);
  });
});

describe('collectSecrets', () => {
  it('returns every configured credential value', () => {
    const result = parseEnv(
      validEnv({ X_API_KEY: fakeXCredential('key'), X_ACCESS_TOKEN: fakeXCredential('token') }),
    );
    if (!result.ok) throw new Error('expected valid env');
    expect(collectSecrets(result.env).sort()).toEqual(
      [
        fakeTelegramToken(),
        fakeOpenAiKey(),
        fakeXCredential('key'),
        fakeXCredential('token'),
      ].sort(),
    );
  });
});
