/**
 * The work done on every tick, in order: keep the instance lease, move overdue
 * posts, publish the next due post, resolve uncertain outcomes, notify the user.
 */
import type { InstanceLease } from '../services/instance-lease.ts';
import type { Notifier } from '../services/notifier.ts';
import type { OutcomeNotifications } from '../services/outcome-notifications.ts';
import type { PublisherService } from '../services/publisher-service.ts';
import type { ReconcilerService } from '../services/reconciler-service.ts';
import type { SchedulerService } from '../services/scheduler-service.ts';
import type { Logger } from '../shared/logger.ts';
import type { TickerTask } from './ticker.ts';

export function createAgentTasks(deps: {
  lease: InstanceLease;
  scheduler: SchedulerService;
  publisher: PublisherService;
  reconciler: ReconcilerService;
  notifications: OutcomeNotifications;
  notifier: Notifier;
  logger: Logger;
  /** Called once if another instance took over the lease; the agent must stop. */
  onLeaseLost: () => void;
}): TickerTask[] {
  const { lease, scheduler, publisher, reconciler, notifications, notifier, logger } = deps;
  let leaseHeld = true;

  const whileLeaseHeld = (name: string, run: () => Promise<unknown> | unknown): TickerTask => ({
    name,
    run: () => (leaseHeld ? run() : undefined),
  });

  return [
    {
      name: 'lease',
      run() {
        if (!leaseHeld) return;
        if (!lease.renew()) {
          leaseHeld = false;
          logger.fatal('Another agent instance took over the publication lease; stopping.');
          deps.onLeaseLost();
        }
      },
    },
    whileLeaseHeld('reschedule-overdue', async () => {
      if (scheduler.isPaused()) return;
      const moves = scheduler.rescheduleOverdue();
      if (moves.length === 0) return;
      logger.info(
        { posts: moves.map((move) => move.publicId) },
        'Moved overdue posts to new slots',
      );
      await notifier.notify({ type: 'rescheduled', moves });
    }),
    whileLeaseHeld('publish', () => publisher.publishNextDue()),
    whileLeaseHeld('reconcile', () => reconciler.reconcile()),
    whileLeaseHeld('notify', () => notifications.dispatch()),
  ];
}
