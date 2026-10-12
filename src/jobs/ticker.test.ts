import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { duePersonalPost, postState } from '../../tests/helpers/db.ts';
import {
  createTestServices,
  silentLogger,
  type TestServices,
} from '../../tests/helpers/services.ts';
import { createInstanceLease } from '../services/instance-lease.ts';
import { createAgentTasks } from './agent-tasks.ts';
import { runTasks, startTicker } from './ticker.ts';

describe('startTicker', () => {
  it('runs tasks in order, isolates failures and never overlaps ticks', async () => {
    const log: string[] = [];
    let running = 0;
    let maxConcurrent = 0;
    const ticker = startTicker({
      intervalMs: 1,
      logger: silentLogger(),
      tasks: [
        {
          name: 'slow',
          run: async () => {
            running += 1;
            maxConcurrent = Math.max(maxConcurrent, running);
            log.push('slow');
            await sleep(5);
            running -= 1;
          },
        },
        {
          name: 'failing',
          run: () => {
            throw new Error('boom');
          },
        },
        { name: 'after', run: () => log.push('after') },
      ],
    });
    await sleep(40);
    await ticker.stop();
    const ticks = log.length / 2;

    expect(log.slice(0, 4)).toEqual(['slow', 'after', 'slow', 'after']);
    expect(maxConcurrent).toBe(1);
    await sleep(10);
    expect(log.length / 2).toBe(ticks); // nothing runs after stop()
  });
});

describe('agent tasks', () => {
  const opened: TestServices[] = [];
  afterEach(() => {
    for (const created of opened.splice(0)) created.handle.close();
  });

  function setup() {
    const s = createTestServices();
    opened.push(s);
    const lease = createInstanceLease({ db: s.db, clock: s.clock, ttlMs: 90_000, owner: 'me' });
    lease.tryAcquire();
    let leaseLost = 0;
    const tasks = createAgentTasks({
      lease,
      scheduler: s.scheduler,
      publisher: s.publisher,
      reconciler: s.reconciler,
      notifications: s.notifications,
      notifier: s.notifier,
      logger: silentLogger(),
      onLeaseLost: () => {
        leaseLost += 1;
      },
    });
    return { s, tasks, leaseLost: () => leaseLost };
  }

  it('publishes a due post and notifies the user in one tick', async () => {
    const { s, tasks } = setup();
    const post = duePersonalPost(s);
    await runTasks(tasks, silentLogger());
    expect(postState(s, post.publicId).status).toBe('published');
    expect(s.notifier.events.map((event) => event.type)).toEqual(['published']);
  });

  it('moves overdue posts and reports it, unless paused', async () => {
    const { s, tasks } = setup();
    const post = duePersonalPost(s);
    s.scheduler.pause();
    s.clock.advance(3 * 3600_000);
    await runTasks(tasks, silentLogger());
    expect(postState(s, post.publicId).scheduled_at).toBe(post.scheduledAt?.getTime());

    s.scheduler.resume();
    await runTasks(tasks, silentLogger());
    expect(postState(s, post.publicId).scheduled_at ?? 0).toBeGreaterThan(s.clock.now().getTime());
    expect(s.notifier.events.map((event) => event.type)).toEqual(['rescheduled']);
    expect(s.x.created).toEqual([]);
  });

  it('stops all work when another instance takes the lease', async () => {
    const { s, tasks, leaseLost } = setup();
    duePersonalPost(s);
    createInstanceLease({ db: s.db, clock: s.clock, ttlMs: 90_000, owner: 'intruder' });
    s.clock.advance(90_001);
    createInstanceLease({
      db: s.db,
      clock: s.clock,
      ttlMs: 90_000,
      owner: 'intruder',
    }).tryAcquire();

    await runTasks(tasks, silentLogger());
    await runTasks(tasks, silentLogger());
    expect(leaseLost()).toBe(1);
    expect(s.x.created).toEqual([]);
  });
});
