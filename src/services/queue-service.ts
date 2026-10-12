/**
 * Personal posts: intake from Telegram, confirmation, cancellation and listing.
 * Personal text is stored and published exactly as received; it is analysed but
 * never modified.
 */
import type { AppDatabase, DbExecutor } from '../db/client.ts';
import {
  countByStatuses,
  findByPublicId,
  insertPostWithFirstVersion,
  listByStatuses,
  type PostRecord,
  publicIdExists,
  setCardMessage,
  updatePost,
} from '../db/repositories/posts.ts';
import {
  assertTransition,
  CANCELLABLE_STATUSES,
  type PostSource,
  type PostStatus,
  QUEUE_STATUSES,
} from '../domain/post.ts';
import type { Slot } from '../domain/scheduling.ts';
import { analyzeText, contentHash, type TextAnalysis, type TextRules } from '../domain/text.ts';
import type { Clock } from '../shared/clock.ts';
import { generatePublicId } from '../shared/ids.ts';
import type { SchedulerService } from './scheduler-service.ts';

export interface PostView {
  publicId: string;
  source: PostSource;
  status: PostStatus;
  version: number;
  text: string;
  weightedLength: number;
  scheduledAt: Date | null;
  createdAt: Date;
}

export type SubmitResult =
  | { kind: 'invalid'; analysis: TextAnalysis }
  | {
      kind: 'needs_confirmation';
      post: PostView;
      analysis: TextAnalysis;
      projectedSlot: Slot | null;
    }
  | { kind: 'scheduled'; post: PostView; analysis: TextAnalysis; slot: Slot }
  | { kind: 'queue_full'; analysis: TextAnalysis };

export type ConfirmResult =
  | { kind: 'queued'; post: PostView; slot: Slot }
  | { kind: 'already_queued'; post: PostView }
  | { kind: 'not_pending'; post: PostView }
  | { kind: 'outdated'; post: PostView }
  | { kind: 'queue_full'; post: PostView }
  | { kind: 'not_found' };

export type CancelResult =
  | { kind: 'cancelled'; post: PostView }
  | { kind: 'already_cancelled'; post: PostView }
  | { kind: 'not_cancellable'; post: PostView }
  | { kind: 'outdated'; post: PostView }
  | { kind: 'not_found' };

export interface QueueSummary {
  counts: Partial<Record<PostStatus, number>>;
  nextScheduled: PostView | null;
}

export interface QueueService {
  submitPersonalPost(text: string): SubmitResult;
  /** Queues a post awaiting confirmation. Idempotent: repeating it changes nothing. */
  confirm(publicId: string, version: number): ConfirmResult;
  /** Cancels a post. With `expectedVersion`, refuses if the post changed since it was displayed. */
  cancel(publicId: string, expectedVersion?: number): CancelResult;
  listQueue(limit: number): { posts: PostView[]; total: number };
  summary(): QueueSummary;
  /** Remembers the Telegram message showing the post's card (to update it later). */
  attachCard(publicId: string, card: { chatId: number; messageId: number }): void;
}

export function createQueueService(deps: {
  db: AppDatabase;
  scheduler: SchedulerService;
  clock: Clock;
  textRules: TextRules;
  confirmPersonalPosts: boolean;
}): QueueService {
  const { db, scheduler, clock, textRules } = deps;
  const immediate = { behavior: 'immediate' } as const;

  function newPublicId(executor: DbExecutor): string {
    for (;;) {
      const candidate = generatePublicId();
      if (!publicIdExists(executor, candidate)) return candidate;
    }
  }

  function reload(executor: DbExecutor, publicId: string): PostView {
    const record = findByPublicId(executor, publicId);
    if (!record) throw new Error(`Post ${publicId} disappeared during an update`);
    return toView(record);
  }

  return {
    submitPersonalPost(text) {
      const analysis = analyzeText(text, textRules);
      if (analysis.errors.length > 0) return { kind: 'invalid', analysis };

      // Warnings (links, possible credentials) always need an explicit confirmation.
      const needsConfirmation = deps.confirmPersonalPosts || analysis.warnings.length > 0;
      const now = clock.now();

      return db.transaction((tx): SubmitResult => {
        const base = {
          publicId: newPublicId(tx),
          source: 'personal' as const,
          text,
          contentHash: contentHash(text),
          weightedLength: analysis.weightedLength,
          origin: 'user_submitted' as const,
          checks: analysis.warnings.length > 0 ? { warnings: analysis.warnings } : null,
          now,
        };

        if (needsConfirmation) {
          const record = insertPostWithFirstVersion(tx, {
            ...base,
            status: 'pending_confirmation',
          });
          const projectedSlot = scheduler.nextFreeSlot(tx, now);
          return { kind: 'needs_confirmation', post: toView(record), analysis, projectedSlot };
        }

        const slot = scheduler.nextFreeSlot(tx, now);
        if (!slot) return { kind: 'queue_full', analysis };
        const record = insertPostWithFirstVersion(tx, {
          ...base,
          status: 'scheduled',
          scheduledAt: slot.at,
          slotKey: slot.key,
        });
        return { kind: 'scheduled', post: toView(record), analysis, slot };
      }, immediate);
    },

    confirm(publicId, version) {
      return db.transaction((tx): ConfirmResult => {
        const record = findByPublicId(tx, publicId);
        if (!record) return { kind: 'not_found' };
        const { post } = record;
        if (post.status === 'scheduled') return { kind: 'already_queued', post: toView(record) };
        if (post.status !== 'pending_confirmation')
          return { kind: 'not_pending', post: toView(record) };
        if (post.currentVersion !== version) return { kind: 'outdated', post: toView(record) };

        const now = clock.now();
        const slot = scheduler.nextFreeSlot(tx, now);
        if (!slot) return { kind: 'queue_full', post: toView(record) };

        assertTransition(post.source, post.status, 'scheduled');
        updatePost(tx, post.id, post.status, {
          status: 'scheduled',
          scheduledAt: slot.at,
          slotKey: slot.key,
          updatedAt: now,
        });
        return { kind: 'queued', post: reload(tx, publicId), slot };
      }, immediate);
    },

    cancel(publicId, expectedVersion) {
      return db.transaction((tx): CancelResult => {
        const record = findByPublicId(tx, publicId);
        if (!record) return { kind: 'not_found' };
        const { post } = record;
        if (post.status === 'cancelled') return { kind: 'already_cancelled', post: toView(record) };
        if (!(CANCELLABLE_STATUSES as readonly PostStatus[]).includes(post.status)) {
          return { kind: 'not_cancellable', post: toView(record) };
        }
        if (expectedVersion !== undefined && post.currentVersion !== expectedVersion) {
          return { kind: 'outdated', post: toView(record) };
        }

        assertTransition(post.source, post.status, 'cancelled');
        // The partial unique index ignores cancelled posts, so the slot is freed.
        updatePost(tx, post.id, post.status, { status: 'cancelled', updatedAt: clock.now() });
        return { kind: 'cancelled', post: reload(tx, publicId) };
      }, immediate);
    },

    listQueue(limit) {
      const counts = countByStatuses(db, QUEUE_STATUSES);
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      return { posts: listByStatuses(db, QUEUE_STATUSES, limit).map(toView), total };
    },

    summary() {
      const [next] = listByStatuses(db, ['scheduled'], 1);
      return {
        counts: countByStatuses(db, [...QUEUE_STATUSES, 'draft']),
        nextScheduled: next ? toView(next) : null,
      };
    },

    attachCard(publicId, card) {
      const record = findByPublicId(db, publicId);
      if (record) setCardMessage(db, record.post.id, card, clock.now());
    },
  };
}

function toView({ post, version }: PostRecord): PostView {
  return {
    publicId: post.publicId,
    source: post.source,
    status: post.status,
    version: post.currentVersion,
    text: version.text,
    weightedLength: version.weightedLength,
    scheduledAt: post.scheduledAt,
    createdAt: post.createdAt,
  };
}
