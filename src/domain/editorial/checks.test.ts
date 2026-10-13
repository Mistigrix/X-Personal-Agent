import { describe, expect, it } from 'vitest';
import {
  type CheckFinding,
  checkDraft,
  countEmojis,
  type DraftRules,
  hasErrors,
} from './checks.ts';
import { describeContentMix } from './content-mix.ts';
import { openingWords, similarity } from './similarity.ts';

const RULES: DraftRules = {
  text: { maxWeightedLength: 280, urlPolicy: 'confirm' },
  bannedPhrases: ['game-changer', "in today's fast-paced world"],
  maxHashtags: 1,
  maxEmojis: 2,
  allowedLanguages: ['en', 'fr'],
  avoidTopics: ['politics'],
  nearDuplicateThreshold: 0.8,
};

function codes(findings: CheckFinding[]) {
  return findings.map((finding) => `${finding.severity}:${finding.code}`);
}

function check(
  text: string,
  overrides: {
    language?: string;
    claims?: { claim: string; basis: 'unsupported' | 'profile_fact' }[];
  } = {},
  recent: string[] = [],
) {
  return checkDraft(
    { text, language: overrides.language ?? 'en', claims: overrides.claims ?? [] },
    RULES,
    recent,
  );
}

describe('checkDraft', () => {
  it('passes a clean draft', () => {
    expect(check('Small teams ship faster with boring technology.')).toEqual([]);
  });

  it('rejects empty and over-length drafts', () => {
    expect(codes(check('   '))).toContain('error:empty');
    expect(codes(check('x'.repeat(281)))).toEqual(['error:too_long']);
  });

  it('rejects banned phrases regardless of case and apostrophe style', () => {
    expect(codes(check('This is a Game-Changer.'))).toEqual(['error:banned_phrase']);
    expect(codes(check('In today’s fast-paced world, ship.'))).toEqual(['error:banned_phrase']);
  });

  it('limits hashtags and emoji', () => {
    expect(codes(check('Ship #fast #often'))).toEqual(['error:too_many_hashtags']);
    expect(codes(check('Ship 🚀🚀🚀'))).toEqual(['error:too_many_emojis']);
    expect(countEmojis('👨‍👩‍👧‍👦 and 👍🏽')).toBe(2);
  });

  it('rejects credentials and languages that are not allowed', () => {
    expect(codes(check(`token sk-${'a'.repeat(40)}`))).toContain('error:possible_secret');
    expect(codes(check('Hola a todos', { language: 'es' }))).toEqual([
      'error:language_not_allowed',
    ]);
  });

  it('warns about links and avoided topics', () => {
    expect(codes(check('Read https://example.com'))).toEqual(['warning:contains_urls']);
    expect(codes(check('My take on politics today'))).toEqual(['warning:avoided_topic']);
  });

  it('rejects duplicates and near-duplicates of recent posts', () => {
    const recent = ['Boring technology wins for small teams. Ship it.'];
    expect(codes(check('boring technology wins for small teams ship it', {}, recent))).toEqual([
      'error:duplicate',
    ]);
    expect(
      codes(
        check('Boring technology wins for small teams. Ship it!!', {}, [
          'Boring technology wins for small teams. Ship it now.',
        ]),
      ),
    ).toEqual(['error:near_duplicate']);
  });

  it('warns about formulaic openings', () => {
    const recent = ['Here is what I learned this week about testing.'];
    expect(
      codes(check('Here is what I learned shipping a database migration.', {}, recent)),
    ).toEqual(['warning:repeated_opening']);
  });

  it('rejects unsupported claims', () => {
    const findings = check('I doubled revenue last month.', {
      claims: [{ claim: 'doubled revenue last month', basis: 'unsupported' }],
    });
    expect(codes(findings)).toEqual(['error:unsupported_claim']);
    expect(hasErrors(findings)).toBe(true);
  });
});

describe('similarity helpers', () => {
  it('scores identical texts 1 and unrelated texts low', () => {
    expect(similarity('Hello world', 'hello, WORLD!')).toBe(1);
    expect(similarity('Boring technology wins', 'I love sourdough bread')).toBeLessThan(0.2);
  });

  it('extracts normalized opening words', () => {
    expect(openingWords('Here’s what I LEARNED, today: tests matter')).toBe(
      'here s what i learned',
    );
  });
});

describe('describeContentMix', () => {
  it('lists categories with targets and flags under-represented ones', () => {
    const text = describeContentMix({ technical: 3, opinion: 1, unused: 0 }, [
      'technical',
      'technical',
    ]);
    expect(text).toContain(
      'Use exactly one of these categories for each idea: technical, opinion.',
    );
    expect(text).toContain('- technical: target 75%, recent 100%');
    expect(text).toContain('- opinion: target 25%, recent 0% (under-represented)');
    expect(text).not.toContain('unused');
  });
});
