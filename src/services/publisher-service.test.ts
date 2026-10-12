import { afterEach, describe, expect, it } from 'vitest';
import {
  attemptsOf,
  duePersonalPost,
  insertScheduledAiPost,
  postState,
} from '../../tests/helpers/db.ts';
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

const NOT_SENT: CreatePostResult = {
  kind: 'rejected',
  retryable: true,
  code: 'network_ECONNREFUSED',
  message: 'Could not reach X.',
};
const TIMEOUT: CreatePostResult = { kind: 'unknown', code: 'timeout', message: 'No answer.' };
const INVALID: CreatePostResult = {
  kind: 'rejected',
  retryable: false,
  httpStatus: 400,
  code: 'http_400',
  message: 'X refused the request (400): Text too long.',
};

describe('publishing a due post', () => {
  it('publishes exactly once and records the X post ID', async () => {
    const s = services();
    const post = duePersonalPost(s, 'Ship it 🚀');

    expect(await s.publisher.publishNextDue()).toEqual({
      publicId: post.publicId,
      result: 'published',
    });
    expect(await s.publisher.publishNextDue()).toBeNull();
    s.clock.advance(24 * 3600_000);
    expect(await s.publisher.publishNextDue()).toBeNull();

    expect(s.x.created).toEqual(['Ship it 🚀']);
    expect(postState(s, post.publicId)).toMatchObject({ status: 'published', x_post_id: '1000' });
    expect(attemptsOf(s, post.publicId)).toEqual([
      expect.objectContaining({ status: 'succeeded', x_post_id: '1000', dry_run: 0 }),
    ]);
  });

  it('does nothing before the publication time', async () => {
    const s = services();
    const post = duePersonalPost(s);
    s.clock.set(new Date((post.scheduledAt?.getTime() ?? 0) - 1000));
    expect(await s.publisher.publishNextDue()).toBeNull();
    expect(s.x.created).toEqual([]);
  });

  it('claims a post only once when two ticks run at the same time', async () => {
    const s = services();
    duePersonalPost(s);
    let release: () => void = () => {};
    s.x.script(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: 'published', postId: '77' });
        }),
    );

    const first = s.publisher.publishNextDue();
    const second = s.publisher.publishNextDue();
    await Promise.resolve();
    release();
    const outcomes = await Promise.all([first, second]);

    expect(s.x.created).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
  });

  it('publishes nothing while paused, and resumes afterwards', async () => {
    const s = services();
    duePersonalPost(s);
    s.scheduler.pause();
    expect(await s.publisher.publishNextDue()).toBeNull();
    expect(s.x.created).toEqual([]);
    s.scheduler.resume();
    expect((await s.publisher.publishNextDue())?.result).toBe('published');
  });

  it('marks dry-run publications without an X post ID', async () => {
    const s = services({ x: createFakeXClient({ dryRun: true }) });
    s.x.script({ kind: 'published', postId: null });
    const post = duePersonalPost(s);
    await s.publisher.publishNextDue();
    expect(postState(s, post.publicId)).toMatchObject({ status: 'published', x_post_id: null });
    expect(attemptsOf(s, post.publicId)[0]).toMatchObject({ status: 'succeeded', dry_run: 1 });
  });
});

describe('failures', () => {
  it('retries a request that was never sent, with backoff', async () => {
    const s = services();
    const post = duePersonalPost(s);
    s.x.script(NOT_SENT);

    expect((await s.publisher.publishNextDue())?.result).toBe('retry_scheduled');
    const retryAt = s.clock.now().getTime() + 60_000;
    expect(postState(s, post.publicId)).toMatchObject({
      status: 'scheduled',
      retry_count: 1,
      scheduled_at: retryAt,
    });
    expect(await s.publisher.publishNextDue()).toBeNull();

    s.clock.set(new Date(retryAt));
    expect((await s.publisher.publishNextDue())?.result).toBe('published');
    expect(s.x.created).toHaveLength(2);
    // A transient failure that recovered is not worth a notification.
    await s.notifications.dispatch();
    expect(s.notifier.events.map((event) => event.type)).toEqual(['published']);
  });

  it('waits for the rate-limit reset before retrying', async () => {
    const s = services();
    const post = duePersonalPost(s);
    const reset = new Date(s.clock.now().getTime() + 15 * 60_000);
    s.x.script({ ...NOT_SENT, code: 'rate_limited', retryAt: reset });
    await s.publisher.publishNextDue();
    expect(postState(s, post.publicId).scheduled_at).toBe(reset.getTime());
  });

  it('gives up after the configured number of retries and reports it', async () => {
    const s = services({ publisher: { maxRetries: 1 } });
    const post = duePersonalPost(s);
    s.x.script(NOT_SENT, NOT_SENT);

    await s.publisher.publishNextDue();
    s.clock.advance(60_000);
    expect((await s.publisher.publishNextDue())?.result).toBe('failed');
    expect(postState(s, post.publicId).status).toBe('failed');

    await s.notifications.dispatch();
    expect(s.notifier.events).toEqual([
      expect.objectContaining({ type: 'publication_failed', reason: 'Could not reach X.' }),
    ]);
  });

  it('does not retry a permanent refusal', async () => {
    const s = services();
    const post = duePersonalPost(s);
    s.x.script(INVALID);
    expect((await s.publisher.publishNextDue())?.result).toBe('failed');
    expect(postState(s, post.publicId)).toMatchObject({
      status: 'failed',
      last_error: INVALID.message,
    });
    s.clock.advance(3600_000);
    expect(await s.publisher.publishNextDue()).toBeNull();
    expect(s.x.created).toHaveLength(1);
  });

  it('never resends a post whose outcome is unknown', async () => {
    const s = services();
    const post = duePersonalPost(s);
    s.x.script(TIMEOUT);

    expect((await s.publisher.publishNextDue())?.result).toBe('uncertain');
    for (let hour = 1; hour <= 48; hour += 1) {
      s.clock.advance(3600_000);
      expect(await s.publisher.publishNextDue()).toBeNull();
    }
    expect(s.x.created).toHaveLength(1);
    expect(postState(s, post.publicId).status).toBe('uncertain');
    expect(attemptsOf(s, post.publicId)).toEqual([
      expect.objectContaining({ status: 'unknown', error_code: 'timeout' }),
    ]);
  });
});

describe('crash recovery', () => {
  it('turns an interrupted attempt into an uncertain one instead of resending it', async () => {
    const s = services();
    const post = duePersonalPost(s);
    // State left by a process killed between "attempt recorded" and "outcome recorded".
    s.handle.sqlite
      .prepare("UPDATE posts SET status = 'publishing' WHERE public_id = ?")
      .run(post.publicId);
    s.handle.sqlite
      .prepare(
        `INSERT INTO publication_attempts (post_id, post_version_id, content_hash, status, dry_run, started_at)
         SELECT p.id, v.id, v.content_hash, 'in_flight', 0, ? FROM posts p
         JOIN post_versions v ON v.post_id = p.id WHERE p.public_id = ?`,
      )
      .run(s.clock.now().getTime(), post.publicId);

    expect(s.publisher.recoverInterrupted()).toBe(1);
    expect(postState(s, post.publicId).status).toBe('uncertain');
    expect(attemptsOf(s, post.publicId)[0]).toMatchObject({
      status: 'unknown',
      error_code: 'interrupted',
    });
    expect(await s.publisher.publishNextDue()).toBeNull();
    expect(s.x.created).toEqual([]);
  });
});

describe('AI-generated posts (hard rule)', () => {
  it('are never sent without an approval, and go back to review', async () => {
    const s = services();
    insertScheduledAiPost(s, { publicId: 'AAAAAA', text: 'Generated', approval: 'none' });
    expect(await s.publisher.publishNextDue()).toEqual({
      publicId: 'AAAAAA',
      result: 'blocked',
      reason: 'missing_approval',
    });
    expect(postState(s, 'AAAAAA').status).toBe('draft');
    expect(s.x.created).toEqual([]);
  });

  it('are never sent with a rejection or the approval of another version', async () => {
    const s = services();
    insertScheduledAiPost(s, { publicId: 'BBBBBB', text: 'Rejected', approval: 'rejected' });
    insertScheduledAiPost(s, { publicId: 'CCCCCC', text: 'Edited', approval: 'previous' });
    expect((await s.publisher.publishNextDue())?.result).toBe('blocked');
    expect((await s.publisher.publishNextDue())?.result).toBe('blocked');
    expect(s.x.created).toEqual([]);
  });

  it('are sent once approved', async () => {
    const s = services();
    insertScheduledAiPost(s, { publicId: 'DDDDDD', text: 'Approved', approval: 'current' });
    expect((await s.publisher.publishNextDue())?.result).toBe('published');
    expect(s.x.created).toEqual(['Approved']);
  });
});

describe('content integrity', () => {
  it('never sends text that no longer matches its recorded hash', async () => {
    const s = services();
    const post = duePersonalPost(s);
    s.handle.sqlite.prepare("UPDATE post_versions SET text = 'tampered'").run();
    expect(await s.publisher.publishNextDue()).toMatchObject({
      result: 'blocked',
      reason: 'content_integrity',
    });
    expect(postState(s, post.publicId).status).toBe('failed');
    expect(s.x.created).toEqual([]);
  });
});

describe('user decisions', () => {
  it('retry reschedules a failed post into the next free slot', async () => {
    const s = services();
    const post = duePersonalPost(s);
    s.x.script(INVALID);
    await s.publisher.publishNextDue();

    const result = s.publisher.retry(post.publicId, 1);
    expect(result.kind).toBe('rescheduled');
    if (result.kind !== 'rescheduled') return;
    expect(postState(s, post.publicId)).toMatchObject({
      status: 'scheduled',
      retry_count: 0,
      last_error: null,
    });
    expect(s.publisher.retry(post.publicId, 1).kind).toBe('not_retryable');

    s.clock.set(result.slot.at);
    expect((await s.publisher.publishNextDue())?.result).toBe('published');
  });

  it('mark-as-published resolves an uncertain post without sending anything', async () => {
    const s = services();
    const post = duePersonalPost(s);
    s.x.script(TIMEOUT);
    await s.publisher.publishNextDue();

    expect(s.publisher.markPublished(post.publicId, 2).kind).toBe('outdated');
    expect(s.publisher.markPublished(post.publicId, 1).kind).toBe('marked');
    expect(postState(s, post.publicId).status).toBe('published');
    expect(attemptsOf(s, post.publicId)[0]).toMatchObject({
      status: 'reconciled_found',
      error_code: 'resolved_by_user',
    });
    expect(s.publisher.markPublished(post.publicId, 1).kind).toBe('not_uncertain');
    expect(s.x.created).toHaveLength(1);
  });

  it('cancelling an uncertain post closes its open attempt', async () => {
    const s = services();
    const post = duePersonalPost(s);
    s.x.script(TIMEOUT);
    await s.publisher.publishNextDue();

    expect(s.queue.cancel(post.publicId, 1).kind).toBe('cancelled');
    expect(attemptsOf(s, post.publicId)[0]).toMatchObject({
      status: 'reconciled_not_found',
      error_code: 'resolved_by_user',
    });
  });
});

describe('outcome notifications', () => {
  it('are delivered once, and retried later when delivery fails', async () => {
    const s = services();
    duePersonalPost(s);
    await s.publisher.publishNextDue();

    s.notifier.deliver = false;
    expect(await s.notifications.dispatch()).toBe(0);
    s.notifier.deliver = true;
    expect(await s.notifications.dispatch()).toBe(0); // waits before retrying
    s.clock.advance(5 * 60_000);
    expect(await s.notifications.dispatch()).toBe(1);
    expect(await s.notifications.dispatch()).toBe(0);
    expect(s.notifier.events.map((event) => event.type)).toEqual(['published']);
  });
});
