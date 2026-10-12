import { describe, expect, it } from 'vitest';
import { findSecrets } from './secret-patterns.ts';

// Samples are assembled at runtime so no credential-shaped literal is committed.
const SAMPLES: Record<string, string> = {
  'Private key block': `-----BEGIN RSA ${'PRIVATE'} KEY-----`,
  'API key (sk-...)': `sk-proj-${'a1B2'.repeat(10)}`,
  'Telegram bot token': `1234567890:${'A'.repeat(2)}${'b'.repeat(33)}`,
  'X access token': `1234567890123-${'Ab3'.repeat(14)}`,
  'GitHub token': `ghp_${'x'.repeat(36)}`,
  'AWS access key ID': `AKIA${'ABCDEFGH23456789'}`,
  'Google API key': `AIza${'g'.repeat(35)}`,
  'Slack token': `xoxb-${'1234567890'}-abc`,
  'Stripe live key': `sk_live_${'z'.repeat(24)}`,
  'JSON Web Token': `eyJ${'h'.repeat(12)}.eyJ${'p'.repeat(12)}.${'s'.repeat(12)}`,
  'Credential assignment': `api_key = "${'Q'.repeat(30)}"`,
};

describe('findSecrets', () => {
  it.each(Object.entries(SAMPLES))('detects a %s', (name, sample) => {
    const matches = findSecrets(`some text ${sample} more text`);
    expect(matches.map((match) => match.name)).toContain(name);
  });

  it('reports positions, never the matched value', () => {
    const sample = SAMPLES['GitHub token'] ?? '';
    const [match] = findSecrets(`prefix ${sample}`);
    expect(match).toEqual({ name: 'GitHub token', index: 7 });
  });

  it.each([
    'Shipped a feature today that took 2 hours to build and 2 weeks to decide.',
    'TELEGRAM_BOT_TOKEN=',
    'X_ACCESS_TOKEN_SECRET: optionalSecret,',
    'Meeting at 10:30, call 555-123-4567.',
    'Read https://example.com/docs/getting-started-with-typescript-and-node',
  ])('ignores ordinary text: %j', (text) => {
    expect(findSecrets(text)).toEqual([]);
  });
});
