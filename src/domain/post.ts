/**
 * Post vocabulary shared by the domain, persistence and presentation layers.
 * Transition rules are added with the services that use them (Milestone 2+).
 */

export const POST_SOURCES = ['personal', 'ai'] as const;
export type PostSource = (typeof POST_SOURCES)[number];

export const POST_STATUSES = [
  /** Personal post received via Telegram, waiting for the user to tap "Queue". */
  'pending_confirmation',
  /** AI-generated post waiting for review. Never publishable in this state. */
  'draft',
  /** Eligible for publication at `scheduled_at` (subject to PublicationPolicy). */
  'scheduled',
  /** Claimed by the publisher; a publication attempt is in flight. */
  'publishing',
  'published',
  /** The last attempt may or may not have created the post on X; needs reconciliation. */
  'uncertain',
  /** Permanent failure or retries exhausted; needs a user decision. */
  'failed',
  'rejected',
  'cancelled',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Statuses in which a post occupies its publication slot (one post per slot). */
export const SLOT_HOLDING_STATUSES = [
  'scheduled',
  'publishing',
  'uncertain',
  'published',
] as const satisfies readonly PostStatus[];

export const VERSION_ORIGINS = [
  'user_submitted',
  'user_edited',
  'ai_generated',
  'ai_regenerated',
] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
