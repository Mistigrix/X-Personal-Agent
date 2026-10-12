/**
 * Classifies X API failures into: definitely not created (retryable or not), or
 * unknown outcome. When in doubt the answer is "unknown": a duplicate post is
 * worse than a delayed one.
 *
 * Shapes match @xdevplatform/xdk 0.6.6 (verified by tests/x-client.contract.test.ts):
 * HTTP errors carry `status` and `headers`; network and parsing errors have
 * `status: 0` and the original error in `data`.
 */
import type { CreatePostResult } from './x-client.ts';

/** Network error codes raised before any byte of the request reached X. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

const DEFAULT_RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 300;

export type CreateFailure = Exclude<CreatePostResult, { kind: 'published' }>;

interface HttpErrorLike {
  status: number;
  headers?: Headers;
  data?: unknown;
  message?: string;
}

function isHttpErrorLike(error: unknown): error is HttpErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number'
  );
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
}

/** Human-readable detail from an X problem response (`detail`, `title`, `errors[0].message`). */
function problemDetail(data: unknown): string {
  if (typeof data === 'string') return data;
  if (typeof data !== 'object' || data === null) return '';
  const problem = data as {
    detail?: unknown;
    title?: unknown;
    message?: unknown;
    errors?: unknown;
  };
  for (const candidate of [problem.detail, problem.message, problem.title]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  if (Array.isArray(problem.errors)) {
    const first = problem.errors[0] as { message?: unknown } | undefined;
    if (typeof first?.message === 'string') return first.message;
  }
  return '';
}

/** When a rate-limited request may be retried, from X's headers. */
export function rateLimitRetryAt(headers: Headers | undefined, now: Date): Date {
  const reset = Number(headers?.get('x-rate-limit-reset'));
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000);
  const retryAfter = Number(headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return new Date(now.getTime() + retryAfter * 1000);
  return new Date(now.getTime() + DEFAULT_RATE_LIMIT_WAIT_MS);
}

function networkCode(data: unknown): string | undefined {
  const cause = (data as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

function classifyNetworkFailure(data: unknown): CreateFailure {
  const code = networkCode(data);
  if (code !== undefined && NOT_SENT_CODES.has(code)) {
    return {
      kind: 'rejected',
      retryable: true,
      code: `network_${code}`,
      message: `Could not reach X (${code}); the request was not sent.`,
    };
  }
  const name = (data as { name?: unknown } | undefined)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'unknown', code: 'timeout', message: 'X did not answer before the timeout.' };
  }
  if (name === 'SyntaxError') {
    return {
      kind: 'unknown',
      code: 'unreadable_response',
      message: 'X answered, but the response could not be read.',
    };
  }
  return {
    kind: 'unknown',
    code: code ? `network_${code}` : 'network_error',
    message: `The connection to X failed after the request was sent${code ? ` (${code})` : ''}.`,
  };
}

/** Classifies an HTTP status (and body) from X. Shared by every endpoint. */
export function classifyHttpFailure(
  status: number,
  headers: Headers | undefined,
  data: unknown,
  now: Date,
): CreateFailure {
  const detail = truncate(problemDetail(data));
  const withDetail = (text: string) => (detail ? `${text}: ${detail}` : text);

  if (status === 429) {
    return {
      kind: 'rejected',
      retryable: true,
      retryAt: rateLimitRetryAt(headers, now),
      httpStatus: status,
      code: 'rate_limited',
      message: 'X rate limit reached.',
    };
  }
  if (status >= 500 || status === 408) {
    return {
      kind: 'unknown',
      httpStatus: status,
      code: `http_${status}`,
      message: withDetail(`X server error ${status}`),
    };
  }
  if (status === 403 && /duplicate content/i.test(detail)) {
    return {
      kind: 'unknown',
      httpStatus: status,
      code: 'duplicate_content',
      message: 'X refused the text as a duplicate of a recent post.',
      duplicateContent: true,
    };
  }
  if (status === 401) {
    return {
      kind: 'rejected',
      retryable: false,
      httpStatus: status,
      code: 'unauthorized',
      message:
        'X rejected the credentials (401). Check the X_* values in .env and that the app has "Read and write" permission.',
    };
  }
  if (status === 402) {
    return {
      kind: 'rejected',
      retryable: false,
      httpStatus: status,
      code: 'payment_required',
      message: withDetail(
        'X API credits or billing problem (402). Check your balance in the X Developer Console',
      ),
    };
  }
  return {
    kind: 'rejected',
    retryable: false,
    httpStatus: status,
    code: status === 403 ? 'forbidden' : `http_${status}`,
    message: withDetail(`X refused the request (${status})`),
  };
}

/** Classifies any error thrown by an X API call. */
export function classifyXFailure(error: unknown, now: Date): CreateFailure {
  if (!isHttpErrorLike(error)) {
    return {
      kind: 'unknown',
      code: 'unexpected_error',
      message: truncate(error instanceof Error ? error.message : String(error)),
    };
  }
  if (error.status === 0) return classifyNetworkFailure(error.data);
  return classifyHttpFailure(error.status, error.headers, error.data, now);
}
