import type { DbExecutor } from '../db/client.ts';
import { getSetting } from '../db/repositories/settings.ts';

export interface Health {
  healthy: boolean;
  detail: string;
}

/**
 * The running agent renews its instance lease on every tick (every 30 s, valid
 * 90 s). A valid lease therefore means the tick loop is alive.
 */
export function checkHealth(db: DbExecutor, now: Date): Health {
  const lease = getSetting(db, 'instance_lease');
  if (!lease) return { healthy: false, detail: 'No running agent holds the lease.' };
  const expiresAt = new Date(lease.expiresAt);
  return expiresAt.getTime() > now.getTime()
    ? { healthy: true, detail: `Agent alive (lease valid until ${expiresAt.toISOString()}).` }
    : {
        healthy: false,
        detail: `The agent stopped renewing its lease at ${expiresAt.toISOString()} (stuck or stopped).`,
      };
}
