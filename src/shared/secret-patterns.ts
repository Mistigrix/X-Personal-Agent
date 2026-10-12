/**
 * Patterns for credentials that must never be committed or published.
 * Used by `pnpm check:secrets` and by the content checks on posts.
 */

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'Private key block', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: 'API key (sk-...)', pattern: /\bsk-[A-Za-z0-9_-]{32,}/ },
  { name: 'Telegram bot token', pattern: /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/ },
  { name: 'X access token', pattern: /\b\d{5,20}-[A-Za-z0-9]{40,}\b/ },
  { name: 'X bearer token', pattern: /\bA{20,}[A-Za-z0-9%]{30,}/ },
  {
    name: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/,
  },
  { name: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripe live key', pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    name: 'Credential assignment',
    pattern:
      /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|client[_-]?secret|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{24,}/i,
  },
];

export interface SecretMatch {
  name: string;
  /** Offset of the match in the scanned text. The matched value is deliberately not returned. */
  index: number;
}

export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      matches.push({ name, index: match.index });
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}
