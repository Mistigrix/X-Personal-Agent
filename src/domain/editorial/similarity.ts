/** Cheap, dependency-free text similarity for duplicate and repetition checks. */
import twitterText from 'twitter-text';

/** Lowercase, NFC, without links, punctuation, symbols or extra whitespace. */
export function normalizeForSimilarity(text: string): string {
  let result = text.normalize('NFC').toLowerCase();
  for (const url of twitterText.extractUrls(result)) result = result.replace(url, ' ');
  return result
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const padded = ` ${normalizeForSimilarity(text)} `;
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1)
    grams.add(padded.slice(index, index + 3));
  return grams;
}

/** Jaccard similarity of character trigrams, from 0 (unrelated) to 1 (identical). */
export function similarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The first words of a text, normalized, to detect formulaic openings. */
export function openingWords(text: string, count = 5): string {
  return normalizeForSimilarity(text).split(' ').slice(0, count).join(' ');
}
