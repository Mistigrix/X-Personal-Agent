import { and, desc, eq, gte } from 'drizzle-orm';
import type { IdeaStatus } from '../../domain/idea.ts';
import type { DbExecutor } from '../client.ts';
import { ideas } from '../schema.ts';

export type IdeaRow = typeof ideas.$inferSelect;

export function insertIdea(
  db: DbExecutor,
  input: Omit<typeof ideas.$inferInsert, 'id' | 'status' | 'createdAt' | 'updatedAt'> & {
    now: Date;
  },
): IdeaRow {
  const { now, ...values } = input;
  return db
    .insert(ideas)
    .values({ ...values, status: 'new', createdAt: now, updatedAt: now })
    .returning()
    .get();
}

export function ideaPublicIdExists(db: DbExecutor, publicId: string): boolean {
  return (
    db.select({ id: ideas.id }).from(ideas).where(eq(ideas.publicId, publicId)).get() !== undefined
  );
}

export function findIdeaByPublicId(db: DbExecutor, publicId: string): IdeaRow | undefined {
  return db.select().from(ideas).where(eq(ideas.publicId, publicId)).get();
}

export function findIdeaById(db: DbExecutor, id: number): IdeaRow | undefined {
  return db.select().from(ideas).where(eq(ideas.id, id)).get();
}

/** Ideas created since `since`, newest first. */
export function listRecentIdeas(db: DbExecutor, since: Date, limit: number): IdeaRow[] {
  return db
    .select()
    .from(ideas)
    .where(gte(ideas.createdAt, since))
    .orderBy(desc(ideas.createdAt), desc(ideas.id))
    .limit(limit)
    .all();
}

/** Changes the status only if it is still `expected`. */
export function setIdeaStatus(
  db: DbExecutor,
  id: number,
  expected: IdeaStatus,
  status: IdeaStatus,
  now: Date,
): boolean {
  return (
    db
      .update(ideas)
      .set({ status, updatedAt: now })
      .where(and(eq(ideas.id, id), eq(ideas.status, expected)))
      .run().changes === 1
  );
}
