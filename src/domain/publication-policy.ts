/**
 * The single rule deciding whether a post may be sent to X right now. Every
 * publication path goes through `checkPublication`, inside the transaction that
 * claims the post. Nothing here is configurable.
 */
import type { ApprovalDecision, PostSource, PostStatus } from './post.ts';
import { contentHash } from './text.ts';

export interface PolicyInput {
  post: {
    source: PostSource;
    status: PostStatus;
    scheduledAt: Date | null;
    currentVersion: number;
  };
  /** The version that would be sent. */
  version: {
    id: number;
    version: number;
    text: string;
    contentHash: string;
  };
  /** The decision recorded for this exact version, if any. */
  approval: {
    postVersionId: number;
    contentHash: string;
    decision: ApprovalDecision;
  } | null;
  hasOpenAttempt: boolean;
  paused: boolean;
  now: Date;
}

export type BlockReason =
  | 'not_scheduled'
  | 'not_due'
  | 'paused'
  | 'open_attempt'
  | 'stale_version'
  | 'content_integrity'
  | 'missing_approval'
  | 'approval_mismatch';

export type PolicyDecision = { publishable: true } | { publishable: false; reason: BlockReason };

/** Reasons that reveal an inconsistent post (as opposed to "not yet"). */
export const INTEGRITY_REASONS: readonly BlockReason[] = [
  'open_attempt',
  'stale_version',
  'content_integrity',
  'missing_approval',
  'approval_mismatch',
];

export function checkPublication(input: PolicyInput): PolicyDecision {
  const { post, version, approval } = input;
  const block = (reason: BlockReason): PolicyDecision => ({ publishable: false, reason });

  if (post.status !== 'scheduled') return block('not_scheduled');
  if (post.scheduledAt === null || post.scheduledAt.getTime() > input.now.getTime()) {
    return block('not_due');
  }
  if (input.paused) return block('paused');
  if (input.hasOpenAttempt) return block('open_attempt');
  if (version.version !== post.currentVersion) return block('stale_version');
  // The stored text must still be the text that was hashed (and approved).
  if (contentHash(version.text) !== version.contentHash) return block('content_integrity');

  if (post.source === 'ai') {
    // Hard rule: an AI-generated post is published only with an explicit
    // approval of this exact version and content.
    if (approval === null || approval.decision !== 'approved') return block('missing_approval');
    if (approval.postVersionId !== version.id || approval.contentHash !== version.contentHash) {
      return block('approval_mismatch');
    }
  }
  return { publishable: true };
}
