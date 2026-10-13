/**
 * Review of AI-generated posts: approve, reject, or edit the exact version
 * shown to the author. An approval is bound to one version and its content
 * hash; any new version (edit or regeneration) needs a new approval.
 */
import { z } from 'zod';
import type { AppDatabase, DbExecutor } from '../db/client.ts';
import { findApprovalForVersion, insertApproval } from '../db/repositories/approvals.ts';
import { findIdeaById } from '../db/repositories/ideas.ts';
import {
  findByPublicId,
  insertVersion,
  listAiPosts,
  type PostRecord,
  updatePost,
} from '../db/repositories/posts.ts';
import {
  type CheckFinding,
  CLAIM_BASES,
  type Claim,
  checkDraft,
  type DraftRules,
} from '../domain/editorial/checks.ts';
import { assertTransition, type PostStatus, type VersionOrigin } from '../domain/post.ts';
import type { Slot } from '../domain/scheduling.ts';
import { analyzeText, contentHash, type TextAnalysis, weightedLength } from '../domain/text.ts';
import type { Clock } from '../shared/clock.ts';
import type { EvaluationSummary } from './editorial/editorial-service.ts';
import type { SchedulerService } from './scheduler-service.ts';

/** Everything the author needs to decide on one version of an AI post. */
export interface ReviewCard {
  publicId: string;
  version: number;
  status: PostStatus;
  origin: VersionOrigin;
  text: string;
  language: string | null;
  weightedLength: number;
  warnings: CheckFinding[];
  claims: Claim[];
  evaluation: EvaluationSummary | null;
  idea: { topic: string; angle: string } | null;
  scheduledAt: Date | null;
}

export type ApproveResult =
  | { kind: 'approved'; card: ReviewCard; slot: Slot }
  | { kind: 'already_approved'; card: ReviewCard }
  | { kind: 'already_rejected'; card: ReviewCard }
  | { kind: 'outdated'; card: ReviewCard }
  | { kind: 'not_reviewable'; card: ReviewCard }
  | { kind: 'invalid'; card: ReviewCard; analysis: TextAnalysis }
  | { kind: 'queue_full'; card: ReviewCard }
  | { kind: 'not_found' };

export type RejectResult =
  | { kind: 'rejected'; card: ReviewCard }
  | { kind: 'already_rejected'; card: ReviewCard }
  | { kind: 'outdated'; card: ReviewCard }
  | { kind: 'not_reviewable'; card: ReviewCard }
  | { kind: 'not_found' };

export type EditResult =
  | { kind: 'edited'; card: ReviewCard }
  | { kind: 'unchanged'; card: ReviewCard }
  | { kind: 'invalid'; analysis: TextAnalysis }
  | { kind: 'outdated'; card: ReviewCard }
  | { kind: 'not_editable'; card: ReviewCard }
  | { kind: 'not_found' };

export interface ReviewService {
  card(publicId: string): ReviewCard | null;
  /** AI drafts waiting for a decision, oldest first. */
  pendingDrafts(limit: number): ReviewCard[];
  approve(publicId: string, version: number, telegramUserId: number): ApproveResult;
  reject(publicId: string, version: number, telegramUserId: number): RejectResult;
  /** The author's own text replaces the draft verbatim, as a new version to approve. */
  edit(publicId: string, baseVersion: number, text: string): EditResult;
}

const storedReviewSchema = z.object({
  warnings: z
    .array(
      z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string() }),
    )
    .catch([]),
  claims: z.array(z.object({ claim: z.string(), basis: z.enum(CLAIM_BASES) })).catch([]),
  evaluation: z
    .object({
      scores: z.object({ voice: z.number(), value: z.number(), clarity: z.number() }),
      issues: z.array(z.string()),
      recommendation: z.enum(['keep', 'revise', 'discard']),
    })
    .nullable()
    .catch(null),
});

const EDITABLE_STATUSES: readonly PostStatus[] = ['draft', 'scheduled'];
const IMMEDIATE = { behavior: 'immediate' } as const;

export function createReviewService(deps: {
  db: AppDatabase;
  scheduler: SchedulerService;
  clock: Clock;
  draftRules: DraftRules;
  /** Texts of recent posts, for the duplicate checks on edited text. */
  recentTexts: (db: DbExecutor) => string[];
}): ReviewService {
  const { db, scheduler, clock, draftRules } = deps;

  function toCard(executor: DbExecutor, { post, version }: PostRecord): ReviewCard {
    const stored = storedReviewSchema.safeParse(version.checks ?? {});
    const review = stored.success ? stored.data : { warnings: [], claims: [], evaluation: null };
    const idea = post.ideaId !== null ? findIdeaById(executor, post.ideaId) : undefined;
    return {
      publicId: post.publicId,
      version: post.currentVersion,
      status: post.status,
      origin: version.origin,
      text: version.text,
      language: post.language,
      weightedLength: version.weightedLength,
      warnings: review.warnings,
      claims: review.claims,
      evaluation: review.evaluation,
      idea: idea ? { topic: idea.topic, angle: idea.angle } : null,
      scheduledAt: post.scheduledAt,
    };
  }

  function transition(
    tx: DbExecutor,
    record: PostRecord,
    to: PostStatus,
    changes: Parameters<typeof updatePost>[3],
  ): void {
    assertTransition(record.post.source, record.post.status, to);
    if (!updatePost(tx, record.post.id, record.post.status, { ...changes, status: to })) {
      throw new Error(`Post ${record.post.publicId} changed concurrently`);
    }
  }

  return {
    card(publicId) {
      const record = findByPublicId(db, publicId);
      return record && record.post.source === 'ai' ? toCard(db, record) : null;
    },

    pendingDrafts(limit) {
      return listAiPosts(db, 'draft', limit).map((record) => toCard(db, record));
    },

    approve(publicId, version, telegramUserId) {
      return db.transaction((tx): ApproveResult => {
        const record = findByPublicId(tx, publicId);
        if (record?.post.source !== 'ai') return { kind: 'not_found' };
        const card = toCard(tx, record);
        if (record.post.currentVersion !== version) return { kind: 'outdated', card };

        const decision = findApprovalForVersion(tx, record.version.id);
        if (decision?.decision === 'approved') return { kind: 'already_approved', card };
        if (decision?.decision === 'rejected') return { kind: 'already_rejected', card };
        if (record.post.status !== 'draft') return { kind: 'not_reviewable', card };

        // The stored text must be exactly the text whose hash the approval records.
        if (contentHash(record.version.text) !== record.version.contentHash) {
          throw new Error(`Content integrity check failed for ${publicId}`);
        }
        const analysis = analyzeText(record.version.text, draftRules.text);
        if (analysis.errors.length > 0) return { kind: 'invalid', card, analysis };

        const now = clock.now();
        const slot = scheduler.nextFreeSlot(tx, now);
        if (!slot) return { kind: 'queue_full', card };

        insertApproval(tx, {
          postId: record.post.id,
          postVersionId: record.version.id,
          contentHash: record.version.contentHash,
          decision: 'approved',
          telegramUserId,
          decidedAt: now,
        });
        transition(tx, record, 'scheduled', {
          scheduledAt: slot.at,
          slotKey: slot.key,
          updatedAt: now,
        });
        const updated = findByPublicId(tx, publicId);
        if (!updated) throw new Error(`Post ${publicId} disappeared`);
        return { kind: 'approved', card: toCard(tx, updated), slot };
      }, IMMEDIATE);
    },

    reject(publicId, version, telegramUserId) {
      return db.transaction((tx): RejectResult => {
        const record = findByPublicId(tx, publicId);
        if (record?.post.source !== 'ai') return { kind: 'not_found' };
        const card = toCard(tx, record);
        if (record.post.currentVersion !== version) return { kind: 'outdated', card };
        if (record.post.status === 'rejected') return { kind: 'already_rejected', card };
        if (record.post.status !== 'draft') return { kind: 'not_reviewable', card };

        const now = clock.now();
        insertApproval(tx, {
          postId: record.post.id,
          postVersionId: record.version.id,
          contentHash: record.version.contentHash,
          decision: 'rejected',
          telegramUserId,
          decidedAt: now,
        });
        transition(tx, record, 'rejected', { updatedAt: now });
        const updated = findByPublicId(tx, publicId);
        if (!updated) throw new Error(`Post ${publicId} disappeared`);
        return { kind: 'rejected', card: toCard(tx, updated) };
      }, IMMEDIATE);
    },

    edit(publicId, baseVersion, text) {
      const analysis = analyzeText(text, draftRules.text);
      if (analysis.errors.length > 0) return { kind: 'invalid', analysis };

      return db.transaction((tx): EditResult => {
        const record = findByPublicId(tx, publicId);
        if (record?.post.source !== 'ai') return { kind: 'not_found' };
        const card = toCard(tx, record);
        if (!EDITABLE_STATUSES.includes(record.post.status)) return { kind: 'not_editable', card };
        if (record.post.currentVersion !== baseVersion) return { kind: 'outdated', card };
        if (record.version.text === text) return { kind: 'unchanged', card };

        // The author's own words: every finding is shown as a warning, nothing is rewritten.
        const others = deps.recentTexts(tx).filter((recent) => recent !== record.version.text);
        const warnings = checkDraft(
          {
            text,
            language: record.post.language ?? draftRules.allowedLanguages[0] ?? 'en',
            claims: [],
          },
          draftRules,
          others,
        ).map((finding) => ({ ...finding, severity: 'warning' as const }));

        const now = clock.now();
        const nextVersion = record.post.currentVersion + 1;
        insertVersion(tx, {
          postId: record.post.id,
          version: nextVersion,
          text,
          contentHash: contentHash(text),
          weightedLength: weightedLength(text),
          origin: 'user_edited',
          checks: { warnings, claims: [], evaluation: null },
          now,
        });
        // A new version always goes back to review: no approval carries over.
        transition(tx, record, 'draft', {
          currentVersion: nextVersion,
          scheduledAt: null,
          slotKey: null,
          updatedAt: now,
        });
        const updated = findByPublicId(tx, publicId);
        if (!updated) throw new Error(`Post ${publicId} disappeared`);
        return { kind: 'edited', card: toCard(tx, updated) };
      }, IMMEDIATE);
    },
  };
}
