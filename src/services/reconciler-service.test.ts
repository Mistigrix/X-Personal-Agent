import { afterEach, describe, expect, it } from 'vitest';
import { attemptsOf, duePersonalPost, postState } from '../../tests/helpers/db.ts';
import { createFakeXClient } from '../../tests/helpers/fake-x.ts';
import { createTestServices, type TestServices } from '../../tests/helpers/services.ts';
import type { CreatePostResult } from '../integrations/x/x-client.ts';

const opened: TestServices[] = [];
function services(options: Parameters<typeof createTestServices>[0] = {}): TestServices {
  const created = createTestServices(options);
  opened.push(created);
  return created;
}
afterEach(() => {
  for (const created of opened.splice(0)) created.handle.close();
});

const TIMEOUT: CreatePostResult = { kind: 'unknown', code: 'timeout', message: 'No answer.' };

/** Publishes a post whose outcome is unknown; `existsOnX` decides whether X actually created it. */
async function uncertainPost(
  s: TestServices,
  existsOnX: boolean,
  result: CreatePostResult = TIMEOUT,
) {
  const post = duePersonalPost(s, 'Is this on X?');
  s.x.script(async () => {
    if (existsOnX) s.x.timeline.unshift({ id: '555', text: 'Is this on X?' });
    return result;
  });
  await s.publisher.publishNextDue();
  return post;
}

/** Runs reconciliation checks at the configured interval. */
async function runChecks(s: TestServices, count: number) {
  for (let check = 0; check < count; check += 1) {
    s.clock.advance(181_000);
    await s.reconciler.reconcile();
  }
}

describe('reconciling uncertain publications', () => {
  it('waits for the initial delay before checking', async () => {
    const s = services();
    await uncertainPost(s, true);
    s.clock.advance(30_000);
    expect(await s.reconciler.reconcile()).toBe(0);
    expect(s.x.timelineReads).toEqual([]);
  });

  it('confirms a post found on the timeline, without resending it', async () => {
    const s = services();
    const post = await uncertainPost(s, true);
    await s.notifications.dispatch(); // same tick as the publication
    await runChecks(s, 1);

    expect(postState(s, post.publicId)).toMatchObject({ status: 'published', x_post_id: '555' });
    expect(attemptsOf(s, post.publicId)[0]).toMatchObject({
      status: 'reconciled_found',
      x_post_id: '555',
    });
    expect(s.x.created).toHaveLength(1);
    await s.notifications.dispatch();
    expect(s.notifier.events.map((event) => event.type)).toEqual([
      'publication_uncertain',
      'publication_confirmed',
    ]);
  });

  it('searches from shortly before the attempt, and identifies the account once', async () => {
    const s = services();
    await uncertainPost(s, false);
    const startedAt = s.clock.now().getTime();
    await runChecks(s, 2);
    expect(s.x.timelineReads.map((read) => read.since.getTime())).toEqual([
      startedAt - 120_000,
      startedAt - 120_000,
    ]);
    expect(s.x.timelineReads[0]?.userId).toBe('42');
    expect(s.x.accountLookups).toBe(1);
  });

  it('asks the user after the last check finds nothing, and never resends', async () => {
    const s = services();
    const post = await uncertainPost(s, false);
    await runChecks(s, 2);
    expect(attemptsOf(s, post.publicId)[0]).toMatchObject({
      status: 'unknown',
      reconcile_checks: 2,
    });

    await runChecks(s, 1);
    expect(attemptsOf(s, post.publicId)[0]).toMatchObject({
      status: 'reconciled_not_found',
      reconcile_checks: 3,
    });
    expect(postState(s, post.publicId).status).toBe('uncertain');
    await runChecks(s, 3);
    expect(s.x.timelineReads).toHaveLength(3);
    expect(s.x.created).toHaveLength(1);

    await s.notifications.dispatch();
    expect(s.notifier.events.at(-1)).toMatchObject({
      type: 'publication_not_found',
      rescheduledAt: null,
    });
  });

  it('reschedules automatically when configured and the timeline was read successfully', async () => {
    const s = services({ reconcile: { autoRetryIfNotFound: true } });
    const post = await uncertainPost(s, false);
    await runChecks(s, 3);
    expect(postState(s, post.publicId)).toMatchObject({ status: 'scheduled', retry_count: 1 });
  });

  it('never reschedules automatically after a duplicate-content refusal', async () => {
    const s = services({ reconcile: { autoRetryIfNotFound: true } });
    const post = await uncertainPost(s, false, {
      kind: 'unknown',
      code: 'duplicate_content',
      message: 'Duplicate.',
      duplicateContent: true,
    });
    await runChecks(s, 3);
    expect(postState(s, post.publicId).status).toBe('uncertain');
  });

  it('never reschedules automatically when the timeline could not be read', async () => {
    const s = services({ reconcile: { autoRetryIfNotFound: true } });
    const post = await uncertainPost(s, false);
    for (let check = 0; check < 3; check += 1) {
      s.x.failNextRead({ kind: 'error', code: 'http_503', message: 'X server error 503' });
    }
    await runChecks(s, 3);
    expect(postState(s, post.publicId).status).toBe('uncertain');
    expect(attemptsOf(s, post.publicId)[0]?.status).toBe('reconciled_not_found');
  });

  it('ignores timeline posts already linked to another post', async () => {
    const s = services();
    const first = duePersonalPost(s, 'Same words');
    await s.publisher.publishNextDue(); // published as id 1000, on the timeline

    const second = duePersonalPost(s, 'Same words');
    s.x.script(TIMEOUT);
    await s.publisher.publishNextDue();
    await runChecks(s, 3);

    expect(postState(s, first.publicId).x_post_id).toBe('1000');
    expect(postState(s, second.publicId).status).toBe('uncertain');
  });

  it('reschedules interrupted dry-run attempts silently (nothing was ever sent)', async () => {
    const s = services({ x: createFakeXClient({ dryRun: true }) });
    const post = await uncertainPost(s, false);
    await runChecks(s, 1);
    expect(postState(s, post.publicId).status).toBe('scheduled');
    expect(s.x.timelineReads).toEqual([]);
  });
});
