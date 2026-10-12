import { describe, expect, it } from 'vitest';
import { checkPublication, type PolicyInput } from './publication-policy.ts';
import { contentHash } from './text.ts';

const NOW = new Date('2026-10-12T10:00:00Z');
const TEXT = 'Hello X';

function input(overrides: {
  post?: Partial<PolicyInput['post']>;
  version?: Partial<PolicyInput['version']>;
  approval?: PolicyInput['approval'];
  hasOpenAttempt?: boolean;
  paused?: boolean;
}): PolicyInput {
  return {
    post: {
      source: 'personal',
      status: 'scheduled',
      scheduledAt: new Date(NOW.getTime() - 1000),
      currentVersion: 1,
      ...overrides.post,
    },
    version: {
      id: 10,
      version: 1,
      text: TEXT,
      contentHash: contentHash(TEXT),
      ...overrides.version,
    },
    approval: overrides.approval ?? null,
    hasOpenAttempt: overrides.hasOpenAttempt ?? false,
    paused: overrides.paused ?? false,
    now: NOW,
  };
}

const APPROVED = {
  postVersionId: 10,
  contentHash: contentHash(TEXT),
  decision: 'approved' as const,
};

describe('checkPublication', () => {
  it('allows a due personal post without approval', () => {
    expect(checkPublication(input({}))).toEqual({ publishable: true });
  });

  it.each([
    ['not scheduled', { post: { status: 'pending_confirmation' as const } }, 'not_scheduled'],
    ['a cancelled post', { post: { status: 'cancelled' as const } }, 'not_scheduled'],
    [
      'a post before its time',
      { post: { scheduledAt: new Date(NOW.getTime() + 1000) } },
      'not_due',
    ],
    ['while paused', { paused: true }, 'paused'],
    ['with an attempt already open', { hasOpenAttempt: true }, 'open_attempt'],
    ['an old version', { version: { version: 1 }, post: { currentVersion: 2 } }, 'stale_version'],
    ['tampered text', { version: { text: 'Hello Y' } }, 'content_integrity'],
  ])('blocks %s', (_label, overrides, reason) => {
    expect(checkPublication(input(overrides))).toEqual({ publishable: false, reason });
  });

  describe('AI-generated posts', () => {
    const ai = { post: { source: 'ai' as const } };

    it('are never publishable without an approval', () => {
      expect(checkPublication(input(ai))).toEqual({
        publishable: false,
        reason: 'missing_approval',
      });
    });

    it('are not publishable after a rejection', () => {
      expect(
        checkPublication(input({ ...ai, approval: { ...APPROVED, decision: 'rejected' } })),
      ).toEqual({
        publishable: false,
        reason: 'missing_approval',
      });
    });

    it('need the approval of this exact version and content', () => {
      expect(
        checkPublication(input({ ...ai, approval: { ...APPROVED, postVersionId: 9 } })),
      ).toEqual({
        publishable: false,
        reason: 'approval_mismatch',
      });
      expect(
        checkPublication(
          input({ ...ai, approval: { ...APPROVED, contentHash: contentHash('other') } }),
        ),
      ).toEqual({ publishable: false, reason: 'approval_mismatch' });
    });

    it('are publishable with a matching approval', () => {
      expect(checkPublication(input({ ...ai, approval: APPROVED }))).toEqual({ publishable: true });
    });
  });
});
