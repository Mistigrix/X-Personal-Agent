import { afterEach, describe, expect, it } from 'vitest';
import { createAiDraft } from '../../tests/helpers/ai.ts';
import { duePersonalPost, postState } from '../../tests/helpers/db.ts';
import { createFakeXClient } from '../../tests/helpers/fake-x.ts';
import { createTestServices, type TestServices } from '../../tests/helpers/services.ts';
import { createStatsService } from './stats-service.ts';

const PRICES = { xPostUsd: 0.015, xPostWithUrlUsd: 0.2 };
const opened: TestServices[] = [];
afterEach(() => {
  for (const created of opened.splice(0)) created.handle.close();
});

function services(options: Parameters<typeof createTestServices>[0] = {}): TestServices {
  const created = createTestServices(options);
  opened.push(created);
  return created;
}

async function publishPersonal(s: TestServices, text: string) {
  duePersonalPost(s, text);
  await s.publisher.publishNextDue();
}

describe('stats', () => {
  it('counts publications, AI review decisions, tokens and estimated X costs', async () => {
    const s = services();
    await publishPersonal(s, 'A plain post.');
    await publishPersonal(s, 'A post with a link https://example.com');

    const approved = await createAiDraft(s, 'An approved AI post.');
    const rejected = await createAiDraft(s, 'A rejected AI post about something else.');
    s.review.reject(rejected.publicId, 1, 111111);
    s.review.approve(approved.publicId, 1, 111111);
    s.clock.set(new Date(postState(s, approved.publicId).scheduled_at ?? 0));
    await s.publisher.publishNextDue();

    const stats = createStatsService({ db: s.db, clock: s.clock, prices: PRICES }).compute([7]);
    expect(stats.periods[0]).toEqual({
      days: 7,
      published: { personal: 2, ai: 1, dryRun: 0, withLinks: 1 },
      aiReview: { generated: 2, approved: 1, rejected: 1 },
      // Each fake model call reports 1000 input (600 cached) and 100 output tokens.
      openAiTokens: { input: 6000, cachedInput: 3600, output: 600 },
      reconciliationChecks: 0,
      estimatedXCostUsd: 2 * 0.015 + 0.2,
    });
  });

  it('keeps dry-run publications apart and out of the cost estimate', async () => {
    const s = services({ x: createFakeXClient({ dryRun: true }) });
    s.x.script({ kind: 'published', postId: null });
    await publishPersonal(s, 'Dry run only.');
    const [period] = createStatsService({ db: s.db, clock: s.clock, prices: PRICES }).compute([
      7,
    ]).periods;
    expect(period?.published).toEqual({ personal: 0, ai: 0, dryRun: 1, withLinks: 0 });
    expect(period?.estimatedXCostUsd).toBe(0);
  });

  it('only counts activity inside each period, and reports open work', async () => {
    const s = services();
    await publishPersonal(s, 'Old post.');
    s.clock.advance(10 * 24 * 3600_000);
    s.queue.submitPersonalPost('Waiting for confirmation.');
    const stats = createStatsService({ db: s.db, clock: s.clock, prices: PRICES }).compute([7, 30]);
    expect(stats.periods.map((period) => period.published.personal)).toEqual([0, 1]);
    expect(stats.open).toEqual({ pending_confirmation: 1 });
  });
});
