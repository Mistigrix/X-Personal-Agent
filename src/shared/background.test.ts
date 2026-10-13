import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../tests/helpers/services.ts';
import { createBackgroundTasks } from './background.ts';

describe('background tasks', () => {
  it('runs one task per key at a time', async () => {
    const tasks = createBackgroundTasks(silentLogger());
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(tasks.run('regenerate:A', () => gate)).toBe(true);
    expect(tasks.run('regenerate:A', async () => {})).toBe(false);
    expect(tasks.run('regenerate:B', async () => {})).toBe(true);
    expect(tasks.isRunning('regenerate:A')).toBe(true);
    release();
    await tasks.idle();
    expect(tasks.isRunning('regenerate:A')).toBe(false);
    expect(tasks.run('regenerate:A', async () => {})).toBe(true);
  });

  it('contains failures', async () => {
    const tasks = createBackgroundTasks(silentLogger());
    tasks.run('boom', async () => {
      throw new Error('boom');
    });
    await expect(tasks.idle()).resolves.toBeUndefined();
  });

  it('aborts running work on stop and refuses new work', async () => {
    const tasks = createBackgroundTasks(silentLogger());
    let aborted = false;
    tasks.run(
      'slow',
      () =>
        new Promise<void>((resolve) => {
          tasks.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
    );
    await tasks.stop();
    expect(aborted).toBe(true);
    expect(tasks.run('later', async () => {})).toBe(false);
  });
});
