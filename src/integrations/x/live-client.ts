/**
 * X API adapter based on the official TypeScript SDK (OAuth 1.0a user context).
 */
import { Client, OAuth1 } from '@xdevplatform/xdk';
import type { Clock } from '../../shared/clock.ts';
import { classifyXFailure } from './errors.ts';
import type { ListPostsResult, XAccount, XClient } from './x-client.ts';

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** Maximum posts read per reconciliation check (owned reads are billed per post). */
const RECONCILIATION_PAGE_SIZE = 20;

export class XRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'XRequestError';
    this.code = code;
  }
}

export function createLiveXClient(options: {
  credentials: XCredentials;
  timeoutMs: number;
  clock: Clock;
  /** Override for tests (local fake server). */
  baseUrl?: string;
}): XClient {
  const { credentials, clock } = options;
  const oauth1 = new OAuth1({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    callback: 'oob',
    accessToken: credentials.accessToken,
    accessTokenSecret: credentials.accessTokenSecret,
  });
  const client = new Client({
    oauth1,
    timeout: options.timeoutMs,
    // The SDK must never resend a request on its own: a resent post creation
    // could publish a duplicate. Retries are decided by the publisher only.
    retry: false,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });

  return {
    dryRun: false,

    async createPost(text) {
      try {
        const response = await client.posts.create({ text });
        const id = response.data?.id;
        if (typeof id !== 'string' || id === '') {
          return {
            kind: 'unknown',
            httpStatus: 201,
            code: 'missing_post_id',
            message: 'X accepted the request but returned no post ID.',
          };
        }
        return { kind: 'published', postId: id };
      } catch (error) {
        return classifyXFailure(error, clock.now());
      }
    },

    async listOwnPostsSince(userId, since): Promise<ListPostsResult> {
      try {
        const response = await client.users.getPosts(userId, {
          // X expects RFC 3339 without milliseconds.
          startTime: since.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          maxResults: RECONCILIATION_PAGE_SIZE,
          exclude: ['replies', 'retweets'],
        });
        const posts = (response.data ?? []).flatMap((post) =>
          typeof post.id === 'string' && typeof post.text === 'string'
            ? [{ id: post.id, text: post.text }]
            : [],
        );
        return { kind: 'ok', posts };
      } catch (error) {
        const failure = classifyXFailure(error, clock.now());
        return {
          kind: 'error',
          code: failure.code,
          message: failure.message,
          ...(failure.kind === 'rejected' && failure.retryAt ? { retryAt: failure.retryAt } : {}),
        };
      }
    },

    async getAccount(): Promise<XAccount> {
      try {
        const response = await client.users.getMe();
        const { id, username } = response.data ?? {};
        if (typeof id !== 'string' || typeof username !== 'string') {
          throw new XRequestError('invalid_response', 'X returned no account information.');
        }
        return { id, username };
      } catch (error) {
        if (error instanceof XRequestError) throw error;
        const failure = classifyXFailure(error, clock.now());
        throw new XRequestError(failure.code, failure.message);
      }
    },
  };
}
