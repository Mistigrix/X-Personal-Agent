import { and, eq } from 'drizzle-orm';
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

/** Starts a run unless one with this name and key already exists. Returns null in that case. */
export function tryStartJobRun(
  db: DbExecutor,
  input: { jobName: string; runKey: string; now: Date },
): number | null {
  const row = db
    .insert(jobRuns)
    .values({
      jobName: input.jobName,
      runKey: input.runKey,
      status: 'running',
      startedAt: input.now,
    })
    .onConflictDoNothing({ target: [jobRuns.jobName, jobRuns.runKey] })
    .returning({ id: jobRuns.id })
    .get();
  return row?.id ?? null;
}

export function jobRunExists(db: DbExecutor, jobName: string, runKey: string): boolean {
  return (
    db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(and(eq(jobRuns.jobName, jobName), eq(jobRuns.runKey, runKey)))
      .get() !== undefined
  );
}
