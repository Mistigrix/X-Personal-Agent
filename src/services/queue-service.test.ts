import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServices, MONDAY_7AM, type TestServices } from '../../tests/helpers/services.ts';
import { contentHash } from '../domain/text.ts';
import type { PostView } from './queue-service.ts';

const opened: TestServices[] = [];
const directories: string[] = [];

function services(options: Parameters<typeof createTestServices>[0] = {}): TestServices {
  const created = createTestServices(options);
  opened.push(created);
  return created;
}

afterEach(() => {
  for (const created of opened.splice(0)) {
    if (created.handle.sqlite.open) created.handle.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function submitAndConfirm(target: TestServices, text: string): PostView {
  const submitted = target.queue.submitPersonalPost(text);
  if (submitted.kind !== 'needs_confirmation') throw new Error(`unexpected ${submitted.kind}`);
  const confirmed = target.queue.confirm(submitted.post.publicId, submitted.post.version);
  if (confirmed.kind !== 'queued') throw new Error(`unexpected ${confirmed.kind}`);
  return confirmed.post;
}

describe('submitting personal posts', () => {
  it('stores the text byte-for-byte, without trimming or normalization', () => {
    const target = services();
    const tricky = [
      '  leading and trailing spaces  ',
      'line one\nline two\n\nline four\n',
      'tab\tseparated',
      'cafe\u0301 (decomposed) vs caf\u00e9',
      'emoji 👨‍👩‍👧‍👦 and 👍🏽',
      'RTL mark ‏ and zero-width joiner ‍',
      'HTML <b>stays</b> & raw',
    ];
    for (const text of tricky) {
      const result = target.queue.submitPersonalPost(text);
      expect(result.kind).toBe('needs_confirmation');
      if (result.kind !== 'needs_confirmation') continue;
      const row = target.handle.sqlite
        .prepare(
          'SELECT text, content_hash FROM post_versions WHERE post_id = (SELECT id FROM posts WHERE public_id = ?)',
        )
        .get(result.post.publicId) as { text: string; content_hash: string };
      expect(row.text).toBe(text);
      expect(row.content_hash).toBe(contentHash(text));
    }
  });

  it('waits for confirmation and shows the slot it would get', () => {
    const target = services();
    const result = target.queue.submitPersonalPost('Hello X');
    expect(result.kind).toBe('needs_confirmation');
    if (result.kind !== 'needs_confirmation') return;
    expect(result.post).toMatchObject({
      status: 'pending_confirmation',
      version: 1,
      scheduledAt: null,
    });
    expect(result.projectedSlot?.at.getTime()).toBeGreaterThan(MONDAY_7AM.getTime());
  });

  it('schedules immediately when confirmation is disabled', () => {
    const target = services({ confirmPersonalPosts: false });
    const result = target.queue.submitPersonalPost('Hello X');
    expect(result.kind).toBe('scheduled');
    if (result.kind !== 'scheduled') return;
    expect(result.post.status).toBe('scheduled');
    expect(result.post.scheduledAt).toEqual(result.slot.at);
  });

  it('still asks for confirmation when there are warnings', () => {
    const target = services({ confirmPersonalPosts: false });
    expect(target.queue.submitPersonalPost('Read https://example.com').kind).toBe(
      'needs_confirmation',
    );
  });

  it('saves nothing for an invalid text', () => {
    const target = services();
    expect(target.queue.submitPersonalPost('x'.repeat(281)).kind).toBe('invalid');
    expect(target.queue.listQueue(10).total).toBe(0);
  });
});

describe('confirming', () => {
  it('books the next free slot exactly once, however often it is repeated', () => {
    const target = services();
    const submitted = target.queue.submitPersonalPost('Hello X');
    if (submitted.kind !== 'needs_confirmation') throw new Error('expected confirmation');
    const first = target.queue.confirm(submitted.post.publicId, 1);
    const second = target.queue.confirm(submitted.post.publicId, 1);
    expect(first.kind).toBe('queued');
    expect(second.kind).toBe('already_queued');
    if (first.kind !== 'queued' || second.kind !== 'already_queued') return;
    expect(second.post.scheduledAt).toEqual(first.slot.at);
    expect(target.queue.summary().counts.scheduled).toBe(1);
  });

  it('gives each post its own slot, in order', () => {
    const target = services();
    const posts = ['one', 'two', 'three', 'four'].map((text) => submitAndConfirm(target, text));
    const times = posts.map((post) => post.scheduledAt?.getTime() ?? 0);
    expect(new Set(times).size).toBe(4);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Three slots per day: the fourth post goes to the next day.
    expect(posts[3]?.scheduledAt?.toISOString().slice(0, 10)).toBe('2026-10-13');
  });

  it('refuses a stale version and unknown posts', () => {
    const target = services();
    const submitted = target.queue.submitPersonalPost('Hello X');
    if (submitted.kind !== 'needs_confirmation') throw new Error('expected confirmation');
    expect(target.queue.confirm(submitted.post.publicId, 2).kind).toBe('outdated');
    expect(target.queue.confirm('ZZZZZZ', 1).kind).toBe('not_found');
  });

  it('does not resurrect a discarded post', () => {
    const target = services();
    const submitted = target.queue.submitPersonalPost('Hello X');
    if (submitted.kind !== 'needs_confirmation') throw new Error('expected confirmation');
    expect(target.queue.cancel(submitted.post.publicId, 1).kind).toBe('cancelled');
    expect(target.queue.confirm(submitted.post.publicId, 1).kind).toBe('not_pending');
  });
});

describe('cancelling', () => {
  it('frees the slot for the next post', () => {
    const target = services();
    const first = submitAndConfirm(target, 'first');
    expect(target.queue.cancel(first.publicId).kind).toBe('cancelled');
    const replacement = submitAndConfirm(target, 'replacement');
    expect(replacement.scheduledAt).toEqual(first.scheduledAt);
  });

  it('is idempotent and refuses posts that can no longer be cancelled', () => {
    const target = services();
    const post = submitAndConfirm(target, 'hello');
    target.queue.cancel(post.publicId);
    expect(target.queue.cancel(post.publicId).kind).toBe('already_cancelled');

    const published = submitAndConfirm(target, 'already out');
    target.handle.sqlite
      .prepare("UPDATE posts SET status = 'published', published_at = 1 WHERE public_id = ?")
      .run(published.publicId);
    expect(target.queue.cancel(published.publicId).kind).toBe('not_cancellable');
  });
});

describe('queue listing', () => {
  it('lists pending and scheduled posts, soonest first, with a total', () => {
    const target = services();
    const later = submitAndConfirm(target, 'scheduled');
    target.queue.submitPersonalPost('pending');
    const { posts, total } = target.queue.listQueue(10);
    expect(total).toBe(2);
    expect(posts.map((post) => post.status)).toEqual(['scheduled', 'pending_confirmation']);
    expect(posts[0]?.publicId).toBe(later.publicId);
    expect(target.queue.listQueue(1).posts).toHaveLength(1);
  });

  it('summarizes counts and the next publication', () => {
    const target = services();
    const first = submitAndConfirm(target, 'first');
    submitAndConfirm(target, 'second');
    target.queue.submitPersonalPost('pending');
    const summary = target.queue.summary();
    expect(summary.counts).toMatchObject({ scheduled: 2, pending_confirmation: 1 });
    expect(summary.nextScheduled?.publicId).toBe(first.publicId);
  });
});

describe('persistence', () => {
  it('keeps the queue, slots, schedule salt and pause state across restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-agent-queue-'));
    directories.push(directory);
    const databasePath = join(directory, 'agent.db');

    const before = services({ databasePath });
    const queued = submitAndConfirm(before, 'survives restarts');
    const projectedBefore = before.queue.submitPersonalPost('projection');
    before.scheduler.pause();
    before.handle.close();

    const after = services({ databasePath });
    const { posts } = after.queue.listQueue(10);
    expect(posts.find((post) => post.publicId === queued.publicId)).toMatchObject({
      status: 'scheduled',
      text: 'survives restarts',
      scheduledAt: queued.scheduledAt,
    });
    expect(after.scheduler.isPaused()).toBe(true);
    const projectedAfter = after.queue.submitPersonalPost('projection');
    if (
      projectedBefore.kind !== 'needs_confirmation' ||
      projectedAfter.kind !== 'needs_confirmation'
    ) {
      throw new Error('expected confirmations');
    }
    expect(projectedAfter.projectedSlot?.at).toEqual(projectedBefore.projectedSlot?.at);
  });
});

describe('pause and resume', () => {
  it('report whether anything changed', () => {
    const target = services();
    expect(target.scheduler.isPaused()).toBe(false);
    expect(target.scheduler.pause()).toBe(true);
    expect(target.scheduler.pause()).toBe(false);
    expect(target.scheduler.isPaused()).toBe(true);
    expect(target.scheduler.resume()).toBe(true);
    expect(target.scheduler.resume()).toBe(false);
  });
});
