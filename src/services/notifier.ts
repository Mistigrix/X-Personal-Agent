import type { PublishMode } from '../domain/publication.ts';

/** Events the agent reports to its owner, independently of the delivery channel. */
export type AgentEvent = {
  type: 'started';
  publishMode: PublishMode;
  paused: boolean;
  queued: number;
};

/**
 * Delivers events to the owner. Implementations must not throw: a delivery
 * failure must never break publication or scheduling.
 */
export interface Notifier {
  notify(event: AgentEvent): Promise<void>;
}
