import type {
  CreatePostResult,
  ListPostsResult,
  RemotePost,
  XAccount,
  XClient,
} from '../../src/integrations/x/x-client.ts';
import type { AgentEvent, Notifier } from '../../src/services/notifier.ts';

type ScriptedResult = CreatePostResult | (() => Promise<CreatePostResult>);

/**
 * Scriptable X API double. By default every post is created (and appears on the
 * fake timeline). Script specific outcomes with `script(...)`.
 */
export interface FakeXClient extends XClient {
  readonly created: string[];
  readonly timeline: RemotePost[];
  readonly timelineReads: { userId: string; since: Date }[];
  accountLookups: number;
  /** Outcomes for the next createPost calls, in order. */
  script(...results: ScriptedResult[]): void;
  /** Overrides the next timeline read. */
  failNextRead(result: Extract<ListPostsResult, { kind: 'error' }>): void;
}

export function createFakeXClient(options: { dryRun?: boolean } = {}): FakeXClient {
  const scripted: ScriptedResult[] = [];
  const readFailures: ListPostsResult[] = [];
  let nextId = 1_000;

  const fake: FakeXClient = {
    dryRun: options.dryRun ?? false,
    created: [],
    timeline: [],
    timelineReads: [],
    accountLookups: 0,
    script: (...results) => {
      scripted.push(...results);
    },
    failNextRead: (result) => {
      readFailures.push(result);
    },
    async createPost(text) {
      fake.created.push(text);
      const next = scripted.shift();
      if (next !== undefined) return typeof next === 'function' ? next() : next;
      const id = String(nextId++);
      fake.timeline.unshift({ id, text });
      return { kind: 'published', postId: id };
    },
    async listOwnPostsSince(userId, since) {
      fake.timelineReads.push({ userId, since });
      return readFailures.shift() ?? { kind: 'ok', posts: [...fake.timeline] };
    },
    async getAccount(): Promise<XAccount> {
      fake.accountLookups += 1;
      return { id: '42', username: 'test_account' };
    },
  };
  return fake;
}

export interface RecordingNotifier extends Notifier {
  readonly events: AgentEvent[];
  /** When false, deliveries fail (as if Telegram were unreachable). */
  deliver: boolean;
}

export function createRecordingNotifier(): RecordingNotifier {
  const notifier: RecordingNotifier = {
    events: [],
    deliver: true,
    async notify(event) {
      if (!notifier.deliver) return false;
      notifier.events.push(event);
      return true;
    },
  };
  return notifier;
}
