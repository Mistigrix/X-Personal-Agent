export const PUBLISH_MODES = ['dry-run', 'live'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

export const ATTEMPT_STATUSES = [
  /** Recorded before the request to X is sent. */
  'in_flight',
  'succeeded',
  /** X definitely did not create the post; safe to retry. */
  'failed_retryable',
  /** X definitely did not create the post; retrying will not help. */
  'failed_permanent',
  /** Outcome unknown (timeout, connection reset, 5xx, crash). Never retried blindly. */
  'unknown',
  'reconciled_found',
  'reconciled_not_found',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** At most one attempt per post may be in one of these statuses. */
export const OPEN_ATTEMPT_STATUSES = [
  'in_flight',
  'unknown',
] as const satisfies readonly AttemptStatus[];

/** Error code marking an uncertain attempt that the user resolved by hand. */
export const RESOLVED_BY_USER = 'resolved_by_user';

const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/** Exponential backoff for retryable failures: base, 2×base, 4×base…, capped at one hour. */
export function retryDelayMs(retryCount: number, baseSeconds: number): number {
  return Math.min(baseSeconds * 1000 * 2 ** retryCount, MAX_RETRY_DELAY_MS);
}
