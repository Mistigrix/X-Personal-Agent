import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.ts';
import { jobRuns } from '../schema.ts';

export function startJobRun(
  db: DbExecutor,
  input: { jobName: string; runKey: string; now: Date },
): number {
  return db
    .insert(jobRuns)
    .values({
      jobName: input.jobName,
      runKey: input.runKey,
      status: 'running',
      startedAt: input.now,
    })
    .returning({ id: jobRuns.id })
    .get().id;
}

export function finishJobRun(
  db: DbExecutor,
  id: number,
  result: {
    status: 'succeeded' | 'failed';
    now: Date;
    error?: string;
    meta?: Record<string, unknown>;
  },
): void {
  db.update(jobRuns)
    .set({
      status: result.status,
      finishedAt: result.now,
      error: result.error ?? null,
      meta: result.meta ?? null,
    })
    .where(eq(jobRuns.id, id))
    .run();
}
