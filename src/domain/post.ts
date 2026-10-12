/**
 * Post vocabulary and lifecycle rules, shared by the domain, persistence and
 * presentation layers. Every status change goes through `assertTransition`.
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

/** Statuses shown by /queue: everything that is neither finished nor awaiting AI review. */
export const QUEUE_STATUSES = [
  'pending_confirmation',
  'scheduled',
  'publishing',
  'uncertain',
  'failed',
] as const satisfies readonly PostStatus[];

/** Statuses from which the user may cancel a post. */
export const CANCELLABLE_STATUSES = [
  'pending_confirmation',
  'scheduled',
  'failed',
] as const satisfies readonly PostStatus[];

const TRANSITIONS: Readonly<Record<PostStatus, readonly PostStatus[]>> = {
  pending_confirmation: ['scheduled', 'cancelled'],
  // draft -> draft: edit or regeneration creates a new version.
  draft: ['draft', 'scheduled', 'rejected'],
  // scheduled -> scheduled: rescheduling, or an edit of a personal post.
  // scheduled -> draft: an approved AI post was edited, so its approval is void.
  scheduled: ['scheduled', 'draft', 'publishing', 'cancelled'],
  publishing: ['published', 'scheduled', 'failed', 'uncertain'],
  uncertain: ['published', 'scheduled', 'cancelled'],
  failed: ['scheduled', 'cancelled'],
  published: [],
  rejected: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  readonly from: PostStatus;
  readonly to: PostStatus;

  constructor(source: PostSource, from: PostStatus, to: PostStatus) {
    super(`Invalid post transition for a ${source} post: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(source: PostSource, from: PostStatus, to: PostStatus): boolean {
  if (!TRANSITIONS[from].includes(to)) return false;
  // Personal posts never enter the AI review states, and AI posts never wait for intake confirmation.
  if (source === 'personal' && (to === 'draft' || to === 'rejected')) return false;
  if (source === 'ai' && to === 'pending_confirmation') return false;
  return true;
}

export function assertTransition(source: PostSource, from: PostStatus, to: PostStatus): void {
  if (!canTransition(source, from, to)) throw new InvalidTransitionError(source, from, to);
}
