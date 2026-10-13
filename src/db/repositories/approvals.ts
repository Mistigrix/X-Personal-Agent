import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.ts';
import { approvals } from '../schema.ts';

export type ApprovalRow = typeof approvals.$inferSelect;

/** The decision recorded for a version (at most one, enforced by a unique index). */
export function findApprovalForVersion(
  db: DbExecutor,
  postVersionId: number,
): ApprovalRow | undefined {
  return db.select().from(approvals).where(eq(approvals.postVersionId, postVersionId)).get();
}

export function insertApproval(
  db: DbExecutor,
  input: Omit<typeof approvals.$inferInsert, 'id'>,
): ApprovalRow {
  return db.insert(approvals).values(input).returning().get();
}
