import type { PostRecord } from '../db/repositories/posts.ts';
import type { PostSource, PostStatus } from '../domain/post.ts';

/** A post as presented to the user: identity, state and current text. */
export interface PostView {
  publicId: string;
  source: PostSource;
  status: PostStatus;
  version: number;
  text: string;
  weightedLength: number;
  scheduledAt: Date | null;
  createdAt: Date;
}

export function toPostView({ post, version }: PostRecord): PostView {
  return {
    publicId: post.publicId,
    source: post.source,
    status: post.status,
    version: post.currentVersion,
    text: version.text,
    weightedLength: version.weightedLength,
    scheduledAt: post.scheduledAt,
    createdAt: post.createdAt,
  };
}
