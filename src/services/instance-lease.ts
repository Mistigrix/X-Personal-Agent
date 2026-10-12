/**
 * Single-instance guard: only the holder of a lease (renewed by every tick)
 * publishes. A crashed instance's lease simply expires.
 */
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/client.ts';
import { deleteSetting, getSetting, setSetting } from '../db/repositories/settings.ts';
import type { Clock } from '../shared/clock.ts';

export type LeaseResult = { acquired: true } | { acquired: false; heldUntil: Date };

export interface InstanceLease {
  readonly owner: string;
  tryAcquire(): LeaseResult;
  /** Extends the lease. Returns false if another instance holds it (this one must stop). */
  renew(): boolean;
  release(): void;
}

export function createInstanceLease(deps: {
  db: AppDatabase;
  clock: Clock;
  ttlMs: number;
  owner?: string;
}): InstanceLease {
  const { db, clock, ttlMs } = deps;
  const owner = deps.owner ?? randomUUID();

  function claim(): LeaseResult {
    return db.transaction(
      (tx) => {
        const now = clock.now();
        const current = getSetting(tx, 'instance_lease');
        if (current && current.owner !== owner && current.expiresAt > now.getTime()) {
          return { acquired: false, heldUntil: new Date(current.expiresAt) };
        }
        setSetting(tx, 'instance_lease', { owner, expiresAt: now.getTime() + ttlMs }, now);
        return { acquired: true };
      },
      { behavior: 'immediate' },
    );
  }

  return {
    owner,
    tryAcquire: claim,
    renew: () => claim().acquired,
    release() {
      db.transaction(
        (tx) => {
          if (getSetting(tx, 'instance_lease')?.owner === owner)
            deleteSetting(tx, 'instance_lease');
        },
        { behavior: 'immediate' },
      );
    },
  };
}
