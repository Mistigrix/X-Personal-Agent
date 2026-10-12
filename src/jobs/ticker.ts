/**
 * Runs a list of tasks periodically. All state lives in the database, so the
 * ticker itself holds nothing to lose on restart. Ticks never overlap: the next
 * one is scheduled only after the previous one finished.
 */
import type { Logger } from '../shared/logger.ts';

export interface TickerTask {
  name: string;
  run(): Promise<unknown> | unknown;
}

export interface Ticker {
  /** Stops scheduling ticks and waits for the current one to finish. */
  stop(): Promise<void>;
}

/** Runs each task once, in order. A failing task is logged and does not stop the others. */
export async function runTasks(tasks: readonly TickerTask[], logger: Logger): Promise<void> {
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      logger.error({ err: error, task: task.name }, 'Background task failed');
    }
  }
}

export function startTicker(options: {
  intervalMs: number;
  tasks: readonly TickerTask[];
  logger: Logger;
}): Ticker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;

  const tick = () => {
    current = runTasks(options.tasks, options.logger).finally(() => {
      current = undefined;
      if (!stopped) timer = setTimeout(tick, options.intervalMs);
    });
  };
  tick();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
