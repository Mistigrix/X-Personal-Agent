import type { PublishMode } from '../domain/publication.ts';

/** The post an event is about, with the version shown to the user (for buttons). */
export interface EventPost {
  publicId: string;
  version: number;
  text: string;
}

/** Events the agent reports to its owner, independently of the delivery channel. */
export type AgentEvent =
  | { type: 'started'; publishMode: PublishMode; paused: boolean; queued: number }
  | { type: 'published'; post: EventPost; xPostId: string | null; dryRun: boolean }
  | { type: 'publication_failed'; post: EventPost; reason: string }
  | { type: 'publication_uncertain'; post: EventPost; reason: string }
  | { type: 'publication_confirmed'; post: EventPost; xPostId: string | null }
  | {
      type: 'publication_not_found';
      post: EventPost;
      reason: string | null;
      /** Set when the post was rescheduled automatically (reconcile.autoRetryIfNotFound). */
      rescheduledAt: Date | null;
    }
  | { type: 'rescheduled'; moves: { publicId: string; to: Date }[] };

/**
 * Delivers events to the owner. Implementations must not throw: a delivery
 * failure must never break publication or scheduling.
 */
export interface Notifier {
  /** Returns true when the event reached at least one recipient. */
  notify(event: AgentEvent): Promise<boolean>;
}
