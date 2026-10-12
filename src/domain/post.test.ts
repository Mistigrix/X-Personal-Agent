import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, InvalidTransitionError, POST_STATUSES } from './post.ts';

describe('post transitions', () => {
  it.each([
    ['personal', 'pending_confirmation', 'scheduled'],
    ['personal', 'pending_confirmation', 'cancelled'],
    ['personal', 'scheduled', 'publishing'],
    ['personal', 'publishing', 'uncertain'],
    ['personal', 'uncertain', 'published'],
    ['personal', 'failed', 'scheduled'],
    ['ai', 'draft', 'draft'],
    ['ai', 'draft', 'scheduled'],
    ['ai', 'draft', 'rejected'],
    ['ai', 'scheduled', 'draft'],
  ] as const)('allows %s: %s -> %s', (source, from, to) => {
    expect(canTransition(source, from, to)).toBe(true);
  });

  it.each([
    ['personal', 'scheduled', 'draft'],
    ['personal', 'pending_confirmation', 'publishing'],
    ['ai', 'draft', 'publishing'],
    ['ai', 'draft', 'pending_confirmation'],
    ['personal', 'uncertain', 'publishing'],
    ['ai', 'rejected', 'scheduled'],
  ] as const)('forbids %s: %s -> %s', (source, from, to) => {
    expect(canTransition(source, from, to)).toBe(false);
  });

  it('treats published, rejected and cancelled as final', () => {
    for (const from of ['published', 'rejected', 'cancelled'] as const) {
      for (const to of POST_STATUSES) {
        expect(canTransition('ai', from, to)).toBe(false);
        expect(canTransition('personal', from, to)).toBe(false);
      }
    }
  });

  it('never lets an AI draft reach publication without going through scheduling', () => {
    expect(canTransition('ai', 'draft', 'publishing')).toBe(false);
    expect(canTransition('ai', 'draft', 'published')).toBe(false);
  });

  it('throws a typed error for invalid transitions', () => {
    expect(() => assertTransition('personal', 'published', 'scheduled')).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition('personal', 'scheduled', 'cancelled')).not.toThrow();
  });
});
