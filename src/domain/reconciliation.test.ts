import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './publication.ts';
import { isSamePost, normalizeForComparison } from './reconciliation.ts';

describe('isSamePost', () => {
  it('matches identical text', () => {
    expect(isSamePost('Hello X', 'Hello X')).toBe(true);
  });

  it('ignores the transformations X applies', () => {
    expect(isSamePost('Fish & chips <3', 'Fish &amp; chips &lt;3')).toBe(true);
    expect(isSamePost('Read https://example.com/a/long/path', 'Read https://t.co/AbCdEf123')).toBe(
      true,
    );
    expect(isSamePost('cafe\u0301\n\nnew  paragraph', 'caf\u00e9 new paragraph')).toBe(true);
  });

  it('does not match different posts', () => {
    expect(isSamePost('Hello X', 'Hello Y')).toBe(false);
    expect(isSamePost('Hello', 'Hello world')).toBe(false);
  });

  it('matches long posts returned truncated, but not short prefixes', () => {
    const long = `${'word '.repeat(80)}end`;
    expect(isSamePost(long, `${long.slice(0, 200)}…`)).toBe(true);
    expect(isSamePost(long, 'word word…')).toBe(false);
  });

  it('normalizes whitespace and links', () => {
    expect(normalizeForComparison('  a\tb  https://x.com/y ')).toBe('a b <url>');
  });
});

describe('retryDelayMs', () => {
  it('doubles from the base delay and caps at one hour', () => {
    expect([0, 1, 2, 3].map((count) => retryDelayMs(count, 60))).toEqual([
      60_000, 120_000, 240_000, 480_000,
    ]);
    expect(retryDelayMs(10, 60)).toBe(3_600_000);
  });
});
