export const REDACTED = '[REDACTED]';

/** Shorter values are too likely to collide with ordinary text to be scrubbed safely. */
const MIN_SECRET_LENGTH = 8;

/**
 * Returns a function that replaces every occurrence of the given secret values
 * (raw or JSON-escaped) with a placeholder. Applied to every serialized log line,
 * so a secret embedded in an error message or URL is caught as well.
 */
export function createSecretScrubber(secrets: readonly string[]): (text: string) => string {
  const needles = [
    ...new Set(
      secrets
        .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
        .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);

  if (needles.length === 0) return (text) => text;
  return (text) => {
    let result = text;
    for (const needle of needles) {
      if (result.includes(needle)) result = result.replaceAll(needle, REDACTED);
    }
    return result;
  };
}
