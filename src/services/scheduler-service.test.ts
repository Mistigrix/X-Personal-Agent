import { afterEach, describe, expect, it } from 'vitest';
import { duePersonalPost, postState } from '../../tests/helpers/db.ts';
import { createTestServices, type TestServices } from '../../tests/helpers/services.ts';

const opened: TestServices[] = [];
function services(): TestServices {
  const created = createTestServices({ maxLatenessMinutes: 30 });
  opened.push(created);
  return created;
}
afterEach(() => {
  for (const created of opened.splice(0)) created.handle.close();
});

describe('rescheduleOverdue', () => {
  it('leaves posts that are only slightly late', () => {
    const s = services();
    const post = duePersonalPost(s);
    s.clock.advance(29 * 60_000);
    expect(s.scheduler.rescheduleOverdue()).toEqual([]);
    expect(postState(s, post.publicId).scheduled_at).toBe(post.scheduledAt?.getTime());
  });

  it('moves posts that missed their time to the next free slots, in order', () => {
    const s = services();
    const first = duePersonalPost(s, 'first');
    const firstSlot = postState(s, first.publicId).slot_key;
    const second = duePersonalPost(s, 'second');
    s.clock.advance(2 * 24 * 3600_000);

    const moves = s.scheduler.rescheduleOverdue();
    expect(moves.map((move) => move.publicId)).toEqual([first.publicId, second.publicId]);
    const [a, b] = [postState(s, first.publicId), postState(s, second.publicId)];
    expect(a.status).toBe('scheduled');
    expect(a.slot_key).not.toBe(firstSlot);
    expect(a.scheduled_at ?? 0).toBeGreaterThan(s.clock.now().getTime());
    expect(b.scheduled_at ?? 0).toBeGreaterThan(a.scheduled_at ?? 0);
    expect(s.scheduler.rescheduleOverdue()).toEqual([]);
  });
});
