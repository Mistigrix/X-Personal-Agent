/**
 * Post text analysis following X's counting rules. Never modifies the text:
 * personal posts are published exactly as written.
 */
import { createHash } from 'node:crypto';
import twitterText from 'twitter-text';
import { findSecrets } from '../shared/secret-patterns.ts';

/** Characters X rejects outright (byte-order marks and non-characters). */
const INVALID_CHARACTERS = /[\uFFFE\uFEFF\uFFFF]/;

export type UrlPolicy = 'allow' | 'confirm' | 'block';

export interface TextRules {
  maxWeightedLength: number;
  urlPolicy: UrlPolicy;
}

/** Problems that make a text unpublishable. */
export type TextError =
  | { kind: 'empty' }
  | { kind: 'too_long'; weightedLength: number; maxWeightedLength: number }
  | { kind: 'invalid_characters' }
  | { kind: 'urls_blocked'; count: number };

/** Problems the author must explicitly acknowledge before queuing. */
export type TextWarning =
  | { kind: 'contains_urls'; count: number }
  | { kind: 'possible_secret'; names: string[] };

export interface TextAnalysis {
  /** Length as counted by X: URLs count 23, emoji and CJK count 2, NFC-normalized. */
  weightedLength: number;
  urls: string[];
  errors: TextError[];
  warnings: TextWarning[];
}

/** X's weighted length, using the official twitter-text implementation. */
export function weightedLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}

export function analyzeText(text: string, rules: TextRules): TextAnalysis {
  const length = weightedLength(text);
  const urls = twitterText.extractUrls(text);
  const errors: TextError[] = [];
  const warnings: TextWarning[] = [];

  if (text.trim() === '') errors.push({ kind: 'empty' });
  if (length > rules.maxWeightedLength) {
    errors.push({
      kind: 'too_long',
      weightedLength: length,
      maxWeightedLength: rules.maxWeightedLength,
    });
  }
  if (INVALID_CHARACTERS.test(text)) errors.push({ kind: 'invalid_characters' });

  if (urls.length > 0) {
    if (rules.urlPolicy === 'block') errors.push({ kind: 'urls_blocked', count: urls.length });
    if (rules.urlPolicy === 'confirm') warnings.push({ kind: 'contains_urls', count: urls.length });
  }

  const secretNames = [...new Set(findSecrets(text).map((match) => match.name))];
  if (secretNames.length > 0) warnings.push({ kind: 'possible_secret', names: secretNames });

  return { weightedLength: length, urls, errors, warnings };
}

/** SHA-256 of the exact UTF-8 text. Approvals and publication attempts are bound to it. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
