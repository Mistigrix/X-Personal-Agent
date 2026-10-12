/**
 * Matching a post we tried to publish against the posts found on the account's
 * timeline, to resolve uncertain publication outcomes.
 */
import twitterText from 'twitter-text';

/** How far before an attempt started to look for the post (clock skew margin). */
export const RECONCILIATION_LOOKBACK_MS = 2 * 60 * 1000;

const MIN_TRUNCATED_PREFIX = 100;

/**
 * Normalizes text the way X may alter it on the way back: NFC, HTML entities
 * (`&amp;`), links rewritten to t.co, whitespace.
 */
export function normalizeForComparison(text: string): string {
  let result = text
    .normalize('NFC')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  for (const url of twitterText.extractUrls(result)) result = result.replace(url, '<url>');
  return result.replace(/\s+/g, ' ').trim();
}

/** True when `remote` (from X) is the post whose text is `local`. */
export function isSamePost(local: string, remote: string): boolean {
  const localText = normalizeForComparison(local);
  const remoteText = normalizeForComparison(remote);
  if (localText === remoteText) return true;
  // Long posts may be returned truncated with an ellipsis.
  if (!remoteText.endsWith('…')) return false;
  const prefix = remoteText.slice(0, -1).trimEnd();
  return prefix.length >= MIN_TRUNCATED_PREFIX && localText.startsWith(prefix);
}
