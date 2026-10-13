/**
 * Runs slow work (model calls) outside the Telegram update loop, so the bot
 * stays responsive. At most one task per key runs at a time; failures are
 * logged; shutdown aborts and waits for what is running.
 */
import type { Logger } from './logger.ts';

export interface BackgroundTasks {
  /** Aborted when the tasks are stopped; pass it to long requests. */
  readonly signal: AbortSignal;
  /** Starts `task` unless one with the same key is running. Returns false if it was not started. */
  run(key: string, task: () => Promise<void>): boolean;
  isRunning(key: string): boolean;
  /** Resolves when every task started so far has finished (tests). */
  idle(): Promise<void>;
  /** Aborts running tasks and waits for them to settle. */
  stop(): Promise<void>;
}

export function createBackgroundTasks(logger: Logger): BackgroundTasks {
  const controller = new AbortController();
  const running = new Map<string, Promise<void>>();

  return {
    signal: controller.signal,
    run(key, task) {
      if (running.has(key) || controller.signal.aborted) return false;
      const promise = task()
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            logger.error({ err: error, task: key }, 'Background task failed');
        })
        .finally(() => running.delete(key));
      running.set(key, promise);
      return true;
    },
    isRunning: (key) => running.has(key),
    async idle() {
      while (running.size > 0) await Promise.all(running.values());
    },
    async stop() {
      controller.abort();
      await Promise.all(running.values());
    },
  };
}
