/**
 * Inline-button payloads (Telegram allows 64 bytes):
 * - `<action>:<publicId>:<version>` for buttons acting on a post. The version
 *   makes every button refer to the exact content it was shown with.
 * - `d:<ideaId>` to draft an idea.
 */
import { parsePublicId } from '../../shared/ids.ts';

const POST_ACTIONS = {
  /** Personal post preview. */
  queue: 'q',
  discard: 'x',
  /** Failed or uncertain publication alerts. */
  retry: 'r',
  markPublished: 'm',
  cancel: 'c',
  /** AI draft review. */
  approve: 'a',
  edit: 'e',
  regenerate: 'g',
  reject: 'j',
} as const;

const DRAFT_IDEA_CODE = 'd';

export type PostAction = keyof typeof POST_ACTIONS;

export type CallbackPayload =
  | { action: PostAction; publicId: string; version: number }
  | { action: 'draftIdea'; ideaId: string };

const ACTION_BY_CODE = new Map<string, PostAction>(
  Object.entries(POST_ACTIONS).map(([action, code]) => [code, action as PostAction]),
);

export function encodeCallback(payload: CallbackPayload): string {
  return payload.action === 'draftIdea'
    ? `${DRAFT_IDEA_CODE}:${payload.ideaId}`
    : `${POST_ACTIONS[payload.action]}:${payload.publicId}:${payload.version}`;
}

export function decodeCallback(data: string): CallbackPayload | null {
  const [code, rawId, rawVersion, ...rest] = data.split(':');
  if (rest.length > 0 || code === undefined || rawId === undefined) return null;
  const id = parsePublicId(rawId);
  if (!id) return null;

  if (code === DRAFT_IDEA_CODE) {
    return rawVersion === undefined ? { action: 'draftIdea', ideaId: id } : null;
  }
  const action = ACTION_BY_CODE.get(code);
  const version = Number(rawVersion);
  if (!action || rawVersion === undefined || !Number.isSafeInteger(version) || version < 1) {
    return null;
  }
  return { action, publicId: id, version };
}
