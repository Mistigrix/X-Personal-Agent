import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { createSecretScrubber, REDACTED } from './redact.ts';

const SECRET = `secret-${'s'.repeat(30)}`;

function captureLogger(secrets: readonly string[] = [SECRET]) {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    format: 'json',
    secrets,
    destination: { write: (line: string) => lines.push(line) },
  });
  return { logger, output: () => lines.join('') };
}

describe('createLogger', () => {
  it('scrubs secret values from messages, fields and errors', () => {
    const { logger, output } = captureLogger();
    logger.info({ url: `https://api.telegram.org/bot${SECRET}/getMe` }, `calling with ${SECRET}`);
    logger.error({ err: new Error(`request failed for ${SECRET}`) }, 'boom');
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain(REDACTED);
    expect(output()).toContain('request failed for');
  });

  it('redacts credential fields by name, even for unregistered values', () => {
    const { logger, output } = captureLogger([]);
    logger.info({ token: 'unregistered-value', client: { apiKey: 'another-value' } }, 'config');
    const entry = JSON.parse(output());
    expect(entry.token).toBe(REDACTED);
    expect(entry.client.apiKey).toBe(REDACTED);
  });

  it('writes structured JSON without host metadata', () => {
    const { logger, output } = captureLogger();
    logger.info({ postId: 'P7K2QX' }, 'published');
    const entry = JSON.parse(output());
    expect(entry).toMatchObject({ level: 30, postId: 'P7K2QX', msg: 'published' });
    expect(entry).not.toHaveProperty('hostname');
    expect(typeof entry.time).toBe('string');
  });
});

describe('createSecretScrubber', () => {
  it('also matches the JSON-escaped form of a secret', () => {
    const quoted = 'abc"def\\ghijkl';
    const scrub = createSecretScrubber([quoted]);
    expect(scrub(JSON.stringify({ value: quoted }))).toBe(`{"value":"${REDACTED}"}`);
  });

  it('ignores values too short to scrub safely', () => {
    expect(createSecretScrubber(['short'])('a short text')).toBe('a short text');
  });

  it('prefers the longest match when secrets overlap', () => {
    const scrub = createSecretScrubber(['abcdefgh', 'abcdefghijkl']);
    expect(scrub('xx abcdefghijkl yy')).toBe(`xx ${REDACTED} yy`);
  });
});
