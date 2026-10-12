import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/client.ts';
import { getSetting, setSetting } from '../db/repositories/settings.ts';
import type { XAccount, XClient } from '../integrations/x/x-client.ts';
import type { Clock } from '../shared/clock.ts';

/**
 * Non-reversible fingerprint of the X credentials, used to notice that `.env`
 * now points at another account (so the cached account is not reused).
 */
export function credentialFingerprint(apiKey: string, accessToken: string): string {
  return createHash('sha256').update(`${apiKey}:${accessToken}`).digest('hex').slice(0, 16);
}

/**
 * Returns the authenticated X account, from the cache when the credentials are
 * unchanged, otherwise with one (paid) `GET /2/users/me` call.
 */
export function createXAccountResolver(deps: {
  db: AppDatabase;
  xClient: XClient;
  clock: Clock;
  fingerprint: string;
}): () => Promise<XAccount> {
  return async () => {
    const cached = getSetting(deps.db, 'x_account');
    if (cached?.fingerprint === deps.fingerprint)
      return { id: cached.id, username: cached.username };
    const account = await deps.xClient.getAccount();
    setSetting(
      deps.db,
      'x_account',
      { ...account, fingerprint: deps.fingerprint },
      deps.clock.now(),
    );
    return account;
  };
}
