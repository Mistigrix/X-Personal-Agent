/**
 * Port to the X API. Implementations translate HTTP into these typed outcomes;
 * they never retry on their own; retry decisions belong to the publisher.
 */

/** Outcome of a post creation request. */
export type CreatePostResult =
  | {
      kind: 'published';
      /** Null in dry-run mode. */
      postId: string | null;
    }
  | {
      /** X definitely did not create the post. */
      kind: 'rejected';
      retryable: boolean;
      /** Earliest time a retry makes sense (e.g. rate-limit reset). */
      retryAt?: Date;
      httpStatus?: number;
      code: string;
      message: string;
    }
  | {
      /** The post may or may not exist: never retry blindly. */
      kind: 'unknown';
      httpStatus?: number;
      code: string;
      message: string;
      /** X said the text duplicates a recent post: strong sign the first attempt succeeded. */
      duplicateContent?: boolean;
    };

export interface RemotePost {
  id: string;
  text: string;
}

export type ListPostsResult =
  | { kind: 'ok'; posts: RemotePost[] }
  | { kind: 'error'; code: string; message: string; retryAt?: Date };

export interface XAccount {
  id: string;
  username: string;
}

export interface XClient {
  readonly dryRun: boolean;
  createPost(text: string): Promise<CreatePostResult>;
  /** The authenticated account's own recent posts created at or after `since` (owned read). */
  listOwnPostsSince(userId: string, since: Date): Promise<ListPostsResult>;
  /** The authenticated account (`GET /2/users/me`, a paid request). */
  getAccount(): Promise<XAccount>;
}
