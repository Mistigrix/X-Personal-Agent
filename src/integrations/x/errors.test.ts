import { describe, expect, it } from 'vitest';
import { classifyXFailure, rateLimitRetryAt } from './errors.ts';

const NOW = new Date('2026-10-12T10:00:00Z');

/** Shape of @xdevplatform/xdk ApiError (verified by the contract test). */
function apiError(status: number, data?: unknown, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers), data, message: `HTTP ${status}` };
}

function networkError(data: unknown) {
  return apiError(0, data);
}

function fetchFailure(code: string) {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });
}

describe('classifyXFailure', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    'treats %s as "not sent, safe to retry"',
    (code) => {
      expect(classifyXFailure(networkError(fetchFailure(code)), NOW)).toMatchObject({
        kind: 'rejected',
        retryable: true,
      });
    },
  );

  it.each([
    ['a timeout', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
    ['a connection reset after sending', fetchFailure('UND_ERR_SOCKET'), 'network_UND_ERR_SOCKET'],
    [
      'an unreadable success response',
      new SyntaxError('Unexpected end of JSON'),
      'unreadable_response',
    ],
    ['an unrecognised network error', new TypeError('fetch failed'), 'network_error'],
  ])('treats %s as an unknown outcome', (_label, data, code) => {
    expect(classifyXFailure(networkError(data), NOW)).toMatchObject({ kind: 'unknown', code });
  });

  it.each([500, 502, 503, 504, 408])('treats HTTP %i as an unknown outcome', (status) => {
    expect(classifyXFailure(apiError(status), NOW).kind).toBe('unknown');
  });

  it('flags duplicate-content refusals as a sign the post already exists', () => {
    const result = classifyXFailure(
      apiError(403, { detail: 'You are not allowed to create a Tweet with duplicate content.' }),
      NOW,
    );
    expect(result).toMatchObject({
      kind: 'unknown',
      code: 'duplicate_content',
      duplicateContent: true,
    });
  });

  it('retries rate limits after the reset time', () => {
    const result = classifyXFailure(apiError(429, {}, { 'x-rate-limit-reset': '1760266800' }), NOW);
    expect(result).toEqual({
      kind: 'rejected',
      retryable: true,
      retryAt: new Date(1_760_266_800_000),
      httpStatus: 429,
      code: 'rate_limited',
      message: 'X rate limit reached.',
    });
  });

  it.each([
    [400, 'http_400'],
    [401, 'unauthorized'],
    [402, 'payment_required'],
    [403, 'forbidden'],
    [404, 'http_404'],
  ])('treats HTTP %i as a permanent refusal (%s)', (status, code) => {
    expect(classifyXFailure(apiError(status, { detail: 'nope' }), NOW)).toMatchObject({
      kind: 'rejected',
      retryable: false,
      code,
    });
  });

  it('includes X problem details in the message, truncated', () => {
    const result = classifyXFailure(apiError(400, { detail: 'x'.repeat(500) }), NOW);
    expect(result.message.length).toBeLessThan(350);
    expect(result.message).toContain('X refused the request (400): xxx');
  });

  it('treats anything unexpected as unknown', () => {
    expect(classifyXFailure(new Error('boom'), NOW)).toMatchObject({
      kind: 'unknown',
      code: 'unexpected_error',
    });
  });
});

describe('rateLimitRetryAt', () => {
  it('falls back to Retry-After, then to 15 minutes', () => {
    expect(rateLimitRetryAt(new Headers({ 'retry-after': '120' }), NOW)).toEqual(
      new Date(NOW.getTime() + 120_000),
    );
    expect(rateLimitRetryAt(new Headers(), NOW)).toEqual(new Date(NOW.getTime() + 15 * 60_000));
  });
});
