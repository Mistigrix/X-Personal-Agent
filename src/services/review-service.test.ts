import { afterEach, describe, expect, it } from 'vitest';
import { createAiDraft } from '../../tests/helpers/ai.ts';
import { duePersonalPost, postState } from '../../tests/helpers/db.ts';
import {
  createTestServices,
  TEST_DRAFT_RULES,
  type TestServices,
} from '../../tests/helpers/services.ts';
import { listRecentTexts } from '../db/repositories/posts.ts';
import { contentHash } from '../domain/text.ts';
import { createReviewService } from './review-service.ts';

const OWNER = 111111;
const opened: TestServices[] = [];
function services(): TestServices {
  const created = createTestServices();
  opened.push(created);
  return created;
}
afterEach(() => {
  for (const created of opened.splice(0)) created.handle.close();
});

function approvals(s: TestServices) {
  return s.handle.sqlite
    .prepare(
      'SELECT a.decision, a.telegram_user_id, v.version, a.content_hash = v.content_hash AS hash_matches FROM approvals a JOIN post_versions v ON v.id = a.post_version_id ORDER BY a.id',
    )
    .all();
}

/** Moves the clock to the post's publication time and runs the publisher. */
async function publishWhenDue(s: TestServices, publicId: string) {
  const at = postState(s, publicId).scheduled_at;
  if (at === null) return null;
  s.clock.set(new Date(at));
  return s.publisher.publishNextDue();
}

describe('approve', () => {
  it('records an approval of the exact version and schedules it', async () => {
    const s = services();
    const draft = await createAiDraft(s, 'Approve me exactly.');
    const result = s.review.approve(draft.publicId, 1, OWNER);
    expect(result.kind).toBe('approved');
    expect(approvals(s)).toEqual([
      { decision: 'approved', telegram_user_id: OWNER, version: 1, hash_matches: 1 },
    ]);
    expect(postState(s, draft.publicId).status).toBe('scheduled');

    expect(await publishWhenDue(s, draft.publicId)).toMatchObject({ result: 'published' });
    expect(s.x.created).toEqual(['Approve me exactly.']);
  });

  it('is idempotent: one approval and one slot, however many clicks', async () => {
    const s = services();
    const draft = await createAiDraft(s);
    s.review.approve(draft.publicId, 1, OWNER);
    const slot = postState(s, draft.publicId).slot_key;
    expect(s.review.approve(draft.publicId, 1, OWNER).kind).toBe('already_approved');
    expect(s.review.approve(draft.publicId, 1, OWNER).kind).toBe('already_approved');
    expect(approvals(s)).toHaveLength(1);
    expect(postState(s, draft.publicId).slot_key).toBe(slot);
  });

  it('refuses stale versions, personal posts and unknown posts', async () => {
    const s = services();
    const draft = await createAiDraft(s);
    expect(s.review.approve(draft.publicId, 2, OWNER).kind).toBe('outdated');
    const personal = duePersonalPost(s);
    expect(s.review.approve(personal.publicId, 1, OWNER).kind).toBe('not_found');
    expect(s.review.approve('ZZZZZZ', 1, OWNER).kind).toBe('not_found');
    expect(approvals(s)).toEqual([]);
  });

  it('refuses text that no longer fits the publishing rules', async () => {
    const s = services();
    const draft = await createAiDraft(s, 'A perfectly fine post that is long enough.');
    const strict = createReviewService({
      db: s.db,
      scheduler: s.scheduler,
      clock: s.clock,
      draftRules: { ...TEST_DRAFT_RULES, text: { maxWeightedLength: 10, urlPolicy: 'confirm' } },
      recentTexts: () => [],
    });
    expect(strict.approve(draft.publicId, 1, OWNER).kind).toBe('invalid');
    expect(approvals(s)).toEqual([]);
  });

  it('never approves text that differs from its recorded hash', async () => {
    const s = services();
    const draft = await createAiDraft(s);
    s.handle.sqlite.prepare("UPDATE post_versions SET text = 'tampered'").run();
    expect(() => s.review.approve(draft.publicId, 1, OWNER)).toThrow(/integrity/);
    expect(approvals(s)).toEqual([]);
    expect(postState(s, draft.publicId).status).toBe('draft');
  });
});

describe('reject', () => {
  it('records the decision and is final', async () => {
    const s = services();
    const draft = await createAiDraft(s);
    expect(s.review.reject(draft.publicId, 1, OWNER).kind).toBe('rejected');
    expect(s.review.reject(draft.publicId, 1, OWNER).kind).toBe('already_rejected');
    expect(s.review.approve(draft.publicId, 1, OWNER).kind).toBe('already_rejected');
    expect(postState(s, draft.publicId).status).toBe('rejected');
    expect(approvals(s)).toEqual([expect.objectContaining({ decision: 'rejected', version: 1 })]);
  });
});

describe('edit', () => {
  it('stores the author text verbatim as a new version that needs its own approval', async () => {
    const s = services();
    const draft = await createAiDraft(s, 'Model wording.');
    s.review.approve(draft.publicId, 1, OWNER);

    const mine = '  My own wording, a game-changer 🚀\n';
    const result = s.review.edit(draft.publicId, 1, mine);
    expect(result.kind).toBe('edited');
    if (result.kind !== 'edited') return;
    expect(result.card).toMatchObject({
      version: 2,
      origin: 'user_edited',
      status: 'draft',
      text: mine,
    });
    expect(result.card.warnings.map((warning) => [warning.code, warning.severity])).toEqual([
      ['banned_phrase', 'warning'],
    ]);
    const stored = s.handle.sqlite
      .prepare('SELECT text, content_hash FROM post_versions WHERE version = 2')
      .get() as {
      text: string;
      content_hash: string;
    };
    expect(stored).toEqual({ text: mine, content_hash: contentHash(mine) });

    // The approval of version 1 does not carry over.
    expect(postState(s, draft.publicId)).toMatchObject({ status: 'draft', scheduled_at: null });
    s.clock.advance(30 * 24 * 3600_000);
    expect(await s.publisher.publishNextDue()).toBeNull();
    expect(s.review.approve(draft.publicId, 1, OWNER).kind).toBe('outdated');

    expect(s.review.approve(draft.publicId, 2, OWNER).kind).toBe('approved');
    expect(await publishWhenDue(s, draft.publicId)).toMatchObject({ result: 'published' });
    expect(s.x.created).toEqual([mine]);
  });

  it('refuses invalid text, no-op edits, stale prompts and decided posts', async () => {
    const s = services();
    const draft = await createAiDraft(s, 'Original.');
    expect(s.review.edit(draft.publicId, 1, 'x'.repeat(300)).kind).toBe('invalid');
    expect(s.review.edit(draft.publicId, 1, 'Original.').kind).toBe('unchanged');
    expect(s.review.edit(draft.publicId, 2, 'New').kind).toBe('outdated');
    s.review.reject(draft.publicId, 1, OWNER);
    expect(s.review.edit(draft.publicId, 1, 'New').kind).toBe('not_editable');
    expect(s.handle.sqlite.prepare('SELECT COUNT(*) FROM post_versions').pluck().get()).toBe(1);
  });

  it('warns when the edit duplicates another post', async () => {
    const s = services();
    s.queue.submitPersonalPost('Boring technology wins for small teams.');
    const draft = await createAiDraft(s, 'Something else entirely.');
    const result = s.review.edit(draft.publicId, 1, 'Boring technology wins for small teams.');
    expect(result.kind === 'edited' && result.card.warnings.map((warning) => warning.code)).toEqual(
      ['duplicate'],
    );
    expect(listRecentTexts(s.db, ['draft'], 5)).toContain(
      'Boring technology wins for small teams.',
    );
  });
});

describe('pendingDrafts', () => {
  it('lists AI drafts waiting for a decision, oldest first', async () => {
    const s = services();
    const first = await createAiDraft(s, 'First draft.');
    const second = await createAiDraft(s, 'Second, different draft.');
    const third = await createAiDraft(s, 'Third one about testing.');
    s.review.reject(second.publicId, 1, OWNER);
    expect(s.review.pendingDrafts(10).map((card) => card.publicId)).toEqual([
      first.publicId,
      third.publicId,
    ]);
    expect(s.review.card(first.publicId)?.idea?.angle).toMatch(/^A specific point about /);
  });
});
