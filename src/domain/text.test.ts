import { describe, expect, it } from 'vitest';
import { analyzeText, contentHash, type TextRules, weightedLength } from './text.ts';

const RULES: TextRules = { maxWeightedLength: 280, urlPolicy: 'confirm' };

describe('weightedLength (X counting rules)', () => {
  it.each([
    ['plain Latin text', 'hello', 5],
    ['accented text, composed', 'caf\u00e9', 4],
    ['accented text, decomposed (NFC-normalized)', 'cafe\u0301', 4],
    ['emoji with skin tone', '👍🏽', 2],
    ['ZWJ family emoji', '👨‍👩‍👧‍👦', 2],
    ['CJK characters', '日本語', 6],
    ['any URL counts 23', 'https://example.com/a/very/long/path?with=query', 23],
    ['bare domain is a URL too', 'example.com', 23],
  ])('%s', (_label, text, expected) => {
    expect(weightedLength(text)).toBe(expected);
  });
});

describe('analyzeText', () => {
  it('accepts a normal post without warnings', () => {
    expect(analyzeText('Shipped a feature today.', RULES)).toEqual({
      weightedLength: 24,
      urls: [],
      errors: [],
      warnings: [],
    });
  });

  it.each(['', '   ', '\n\t'])('rejects empty or whitespace-only text %j', (text) => {
    expect(analyzeText(text, RULES).errors).toContainEqual({ kind: 'empty' });
  });

  it('rejects text over the configured weighted length', () => {
    expect(analyzeText('x'.repeat(281), RULES).errors).toEqual([
      { kind: 'too_long', weightedLength: 281, maxWeightedLength: 280 },
    ]);
    expect(analyzeText('x'.repeat(280), RULES).errors).toEqual([]);
  });

  it('counts emoji as 2 when checking the limit', () => {
    expect(analyzeText('😀'.repeat(141), RULES).errors).toEqual([
      { kind: 'too_long', weightedLength: 282, maxWeightedLength: 280 },
    ]);
  });

  it('supports longer limits for Premium accounts', () => {
    expect(analyzeText('x'.repeat(1000), { ...RULES, maxWeightedLength: 25_000 }).errors).toEqual(
      [],
    );
  });

  it('rejects characters X does not accept', () => {
    expect(analyzeText(`a${String.fromCharCode(0xfffe)}b`, RULES).errors).toEqual([
      { kind: 'invalid_characters' },
    ]);
  });

  it.each([
    ['allow', [], []],
    ['confirm', [], [{ kind: 'contains_urls', count: 1 }]],
    ['block', [{ kind: 'urls_blocked', count: 1 }], []],
  ] as const)('applies the %s URL policy', (urlPolicy, errors, warnings) => {
    const analysis = analyzeText('Read https://example.com', { ...RULES, urlPolicy });
    expect(analysis.urls).toEqual(['https://example.com']);
    expect(analysis.errors).toEqual(errors);
    expect(analysis.warnings).toEqual(warnings);
  });

  it('warns about credential-looking strings without exposing them', () => {
    const key = `sk-${'A'.repeat(40)}`;
    const analysis = analyzeText(`my key is ${key}`, RULES);
    expect(analysis.warnings).toEqual([{ kind: 'possible_secret', names: ['API key (sk-...)'] }]);
    expect(JSON.stringify(analysis)).not.toContain(key);
  });
});

describe('contentHash', () => {
  it('is a SHA-256 hex digest of the exact bytes', () => {
    expect(contentHash('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('distinguishes texts X would count identically', () => {
    expect(contentHash('hello ')).not.toBe(contentHash('hello'));
    expect(contentHash('caf\u00e9')).not.toBe(contentHash('cafe\u0301'));
  });
});
