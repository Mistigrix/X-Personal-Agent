import type { XClient } from './x-client.ts';

/**
 * Used when PUBLISH_MODE=dry-run: never touches the network. Every publication
 * "succeeds" without a post ID, so the whole flow can be exercised safely.
 */
export function createDryRunXClient(): XClient {
  return {
    dryRun: true,
    async createPost() {
      return { kind: 'published', postId: null };
    },
    async listOwnPostsSince() {
      return { kind: 'ok', posts: [] };
    },
    async getAccount() {
      throw new Error('There is no X account in dry-run mode.');
    },
  };
}
