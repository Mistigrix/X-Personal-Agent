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
