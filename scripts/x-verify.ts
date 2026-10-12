/**
 * Checks the X API credentials in .env with ONE request: GET /2/users/me.
 * X bills this request (about $0.01 as of October 2026). Nothing is posted.
 * It cannot verify the "Read and write" permission without posting; the agent
 * reports a 401/403 clearly if that permission is missing at publication time.
 */
import { resolve } from 'node:path';
import { createLiveXClient } from '../src/integrations/x/live-client.ts';
import { systemClock } from '../src/shared/clock.ts';
import { readEnvironment } from '../src/shared/dotenv.ts';

const root = resolve(import.meta.dirname, '..');
const env = readEnvironment(root);
const names = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const;
const values = names.map((name) => env[name]?.trim() ?? '');
const missing = names.filter((_, index) => values[index] === '');
if (missing.length > 0) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  console.error('Copy them from your app in the X Developer Console (Keys and tokens).');
  process.exit(78);
}
const [apiKey = '', apiSecret = '', accessToken = '', accessTokenSecret = ''] = values;

console.log('Checking X credentials with one paid request (GET /2/users/me)…');
const client = createLiveXClient({
  credentials: { apiKey, apiSecret, accessToken, accessTokenSecret },
  timeoutMs: 20_000,
  clock: systemClock,
});
try {
  const account = await client.getAccount();
  console.log(`Credentials OK: authenticated as @${account.username} (id ${account.id}).`);
  console.log(
    'Reminder: the app needs "Read and write" permission, set BEFORE generating the access token.',
  );
} catch (error) {
  console.error(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
