/**
 * Deterministic quality checks for AI-generated drafts. Errors trigger an
 * automatic revision; warnings are shown to the author at review time. None of
 * this replaces the author's explicit approval.
 */
import twitterText from 'twitter-text';
import { analyzeText, type TextRules } from '../text.ts';
import { normalizeForSimilarity, openingWords, similarity } from './similarity.ts';

export const CLAIM_BASES = [
  'profile_fact',
  'profile_opinion',
  'general_knowledge',
  'unsupported',
] as const;
export type ClaimBasis = (typeof CLAIM_BASES)[number];

export interface Claim {
  claim: string;
  basis: ClaimBasis;
}

export interface DraftCandidate {
  text: string;
  language: string;
  claims: readonly Claim[];
}

export interface DraftRules {
  text: TextRules;
  bannedPhrases: readonly string[];
  maxHashtags: number;
  maxEmojis: number;
  allowedLanguages: readonly string[];
  avoidTopics: readonly string[];
  nearDuplicateThreshold: number;
}

export interface CheckFinding {
  code: string;
  severity: 'error' | 'warning';
  /** Written so it can be shown to the author and given back to the model as a revision note. */
  message: string;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function countEmojis(text: string): number {
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) count += 1;
  }
  return count;
}

/** Case-, accent-form- and apostrophe-insensitive containment. */
function containsPhrase(text: string, phrase: string): boolean {
  const normalize = (value: string) =>
    value.normalize('NFC').toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ');
  return normalize(text).includes(normalize(phrase));
}

function quoted(text: string): string {
  return `"${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`;
}

/**
 * @param recentTexts texts of recent posts and drafts (newest first), used for
 *   duplicate and repetition checks
 */
export function checkDraft(
  draft: DraftCandidate,
  rules: DraftRules,
  recentTexts: readonly string[],
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const error = (code: string, message: string) =>
    findings.push({ code, severity: 'error', message });
  const warning = (code: string, message: string) =>
    findings.push({ code, severity: 'warning', message });

  const analysis = analyzeText(draft.text, rules.text);
  for (const problem of analysis.errors) {
    switch (problem.kind) {
      case 'empty':
        error('empty', 'The post is empty.');
        break;
      case 'too_long':
        error(
          'too_long',
          `The post is ${problem.weightedLength} characters as counted by X; the maximum is ${problem.maxWeightedLength}.`,
        );
        break;
      case 'invalid_characters':
        error('invalid_characters', 'The post contains characters X does not accept.');
        break;
      case 'urls_blocked':
        error('urls_blocked', 'The post contains a link, and links are not allowed.');
        break;
    }
  }
  for (const notice of analysis.warnings) {
    if (notice.kind === 'contains_urls') {
      warning(
        'contains_urls',
        'The post contains a link (posts with links cost more on the X API).',
      );
    } else {
      error(
        'possible_secret',
        `The post looks like it contains a credential (${notice.names.join(', ')}).`,
      );
    }
  }

  for (const phrase of rules.bannedPhrases) {
    if (containsPhrase(draft.text, phrase))
      error('banned_phrase', `The post uses the banned phrase ${quoted(phrase)}.`);
  }

  const hashtags = twitterText.extractHashtags(draft.text).length;
  if (hashtags > rules.maxHashtags) {
    error(
      'too_many_hashtags',
      `The post has ${hashtags} hashtags; the maximum is ${rules.maxHashtags}.`,
    );
  }
  const emojis = countEmojis(draft.text);
  if (emojis > rules.maxEmojis) {
    error('too_many_emojis', `The post has ${emojis} emoji; the maximum is ${rules.maxEmojis}.`);
  }

  if (!rules.allowedLanguages.includes(draft.language)) {
    error(
      'language_not_allowed',
      `The post is in "${draft.language}", which is not one of the allowed languages (${rules.allowedLanguages.join(', ')}).`,
    );
  }

  for (const topic of rules.avoidTopics) {
    if (containsPhrase(draft.text, topic)) {
      warning('avoided_topic', `The post mentions ${quoted(topic)}, a topic to avoid.`);
    }
  }

  const normalized = normalizeForSimilarity(draft.text);
  const opening = openingWords(draft.text);
  let repeatedOpening = false;
  for (const recent of recentTexts) {
    if (normalizeForSimilarity(recent) === normalized) {
      error('duplicate', 'The post repeats a recent post word for word.');
      break;
    }
    const score = similarity(draft.text, recent);
    if (score >= rules.nearDuplicateThreshold) {
      error('near_duplicate', `The post is too similar to a recent post: ${quoted(recent)}.`);
      break;
    }
    if (!repeatedOpening && opening.split(' ').length >= 4 && openingWords(recent) === opening) {
      repeatedOpening = true;
      warning('repeated_opening', `The post opens like a recent post: ${quoted(recent)}.`);
    }
  }

  for (const claim of draft.claims) {
    if (claim.basis === 'unsupported') {
      error(
        'unsupported_claim',
        `Unsupported claim (not in the author's profile): ${quoted(claim.claim)}. Remove it or rephrase without it.`,
      );
    }
  }

  return findings;
}

export function hasErrors(findings: readonly CheckFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}
