/**
 * Inline-button payloads: `<action>:<publicId>:<version>` (Telegram allows 64 bytes).
 * The version makes every button refer to the exact content it was shown with.
 */
import { parsePublicId } from '../../shared/ids.ts';

const ACTIONS = {
  queue: 'q',
  discard: 'x',
} as const;

export type CallbackAction = keyof typeof ACTIONS;

export interface CallbackPayload {
  action: CallbackAction;
  publicId: string;
  version: number;
}

const ACTION_BY_CODE = new Map<string, CallbackAction>(
  Object.entries(ACTIONS).map(([action, code]) => [code, action as CallbackAction]),
);

export function encodeCallback(payload: CallbackPayload): string {
  return `${ACTIONS[payload.action]}:${payload.publicId}:${payload.version}`;
}

export function decodeCallback(data: string): CallbackPayload | null {
  const [code, rawId, rawVersion, ...rest] = data.split(':');
  if (rest.length > 0 || code === undefined || rawId === undefined || rawVersion === undefined) {
    return null;
  }
  const action = ACTION_BY_CODE.get(code);
  const publicId = parsePublicId(rawId);
  const version = Number(rawVersion);
  if (!action || !publicId || !Number.isSafeInteger(version) || version < 1) return null;
  return { action, publicId, version };
}
