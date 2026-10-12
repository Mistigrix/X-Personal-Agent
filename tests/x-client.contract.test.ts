/**
 * Contract test: the real X adapter (official SDK) against a local fake X API.
 * Locks in the SDK behaviour the publisher's safety depends on, so an SDK
 * upgrade that changes it fails here instead of risking duplicate posts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveXClient } from '../src/integrations/x/live-client.ts';
import { systemClock } from '../src/shared/clock.ts';

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server;
let baseUrl: string;
const received: Received[] = [];
const requestsPerScenario = new Map<string, number>();

function json(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function handle(req: IncomingMessage, res: ServerResponse, body: string) {
  const [, scenario = ''] = (req.url ?? '').split('/');
  requestsPerScenario.set(scenario, (requestsPerScenario.get(scenario) ?? 0) + 1);
  received.push({
    method: req.method ?? '',
    url: req.url ?? '',
    authorization: req.headers.authorization,
    contentType: req.headers['content-type'],
    body,
  });
  switch (scenario) {
    case 'ok':
      if (req.url?.includes('/2/users/me'))
        return json(res, 200, { data: { id: '42', username: 'someone', name: 'Someone' } });
      if (req.url?.includes('/2/users/42/tweets')) {
        return json(res, 200, {
          data: [{ id: '7', text: 'Fish &amp; chips', edit_history_tweet_ids: ['7'] }],
          meta: {},
        });
      }
      return json(res, 201, {
        data: { id: '1844', text: 'ignored', edit_history_tweet_ids: ['1844'] },
      });
    case 'invalid':
      return json(res, 400, { title: 'Invalid Request', detail: 'Text too long.' });
    case 'duplicate':
      return json(res, 403, {
        title: 'Forbidden',
        status: 403,
        detail: 'You are not allowed to create a Tweet with duplicate content.',
      });
    case 'unauthorized':
      return json(res, 401, { title: 'Unauthorized', status: 401 });
    case 'rate':
      return json(res, 429, { title: 'Too Many Requests' }, { 'x-rate-limit-reset': '1900000000' });
    case 'down':
      return json(res, 503, { title: 'Service Unavailable' });
    case 'no-id':
      return json(res, 201, { data: {} });
    case 'unreadable':
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end('{"data": {"id": "18');
    case 'reset':
      return req.socket.destroy();
    case 'hang':
      return; // never answers
  }
  json(res, 404, { title: 'Not Found' });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => handle(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function client(scenario: string, base = baseUrl) {
  return createLiveXClient({
    credentials: {
      apiKey: 'test-consumer-key',
      apiSecret: 'test-consumer-secret',
      accessToken: '42-test-access-token',
      accessTokenSecret: 'test-access-secret',
    },
    timeoutMs: 300,
    clock: systemClock,
    baseUrl: `${base}/${scenario}`,
  });
}

async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}`;
}

describe('createPost', () => {
  it('sends the exact text as JSON with an OAuth 1.0a header', async () => {
    const text = 'Hello & welcome = "x"\n🚀 cafe\u0301  ';
    const result = await client('ok').createPost(text);
    expect(result).toEqual({ kind: 'published', postId: '1844' });

    const request = received.find((entry) => entry.url === '/ok/2/tweets');
    expect(request?.method).toBe('POST');
    expect(request?.contentType).toBe('application/json');
    expect(JSON.parse(request?.body ?? '{}')).toEqual({ text });
    expect(request?.authorization).toMatch(
      /^OAuth (?=.*oauth_consumer_key="test-consumer-key")(?=.*oauth_token="42-test-access-token")(?=.*oauth_signature_method="HMAC-SHA1")(?=.*oauth_signature=").*/,
    );
  });

  it.each([
    ['invalid', { kind: 'rejected', retryable: false, httpStatus: 400 }],
    ['unauthorized', { kind: 'rejected', retryable: false, code: 'unauthorized' }],
    [
      'rate',
      {
        kind: 'rejected',
        retryable: true,
        code: 'rate_limited',
        retryAt: new Date(1_900_000_000_000),
      },
    ],
    ['duplicate', { kind: 'unknown', code: 'duplicate_content', duplicateContent: true }],
    ['down', { kind: 'unknown', httpStatus: 503 }],
    ['no-id', { kind: 'unknown', code: 'missing_post_id' }],
    ['unreadable', { kind: 'unknown', code: 'unreadable_response' }],
    ['reset', { kind: 'unknown' }],
    ['hang', { kind: 'unknown', code: 'timeout' }],
  ])('classifies the "%s" scenario', async (scenario, expected) => {
    expect(await client(scenario).createPost('hello')).toMatchObject(expected);
  });

  it('never resends a request on its own, whatever the outcome', async () => {
    for (const scenario of ['down', 'reset', 'hang', 'rate']) {
      requestsPerScenario.delete(scenario);
      await client(scenario).createPost('once');
      expect(requestsPerScenario.get(scenario), scenario).toBe(1);
    }
  });

  it('reports a refused connection as "not sent"', async () => {
    const result = await client('ok', await closedPortUrl()).createPost('hello');
    expect(result).toMatchObject({
      kind: 'rejected',
      retryable: true,
      code: 'network_ECONNREFUSED',
    });
  });
});

describe('reading', () => {
  it('lists own posts since a time, without replies or reposts', async () => {
    const result = await client('ok').listOwnPostsSince('42', new Date('2026-10-12T09:58:00.123Z'));
    expect(result).toEqual({ kind: 'ok', posts: [{ id: '7', text: 'Fish &amp; chips' }] });

    const request = received.find((entry) => entry.url.startsWith('/ok/2/users/42/tweets'));
    const query = new URL(request?.url ?? '', 'http://x').searchParams;
    expect(query.get('start_time')).toBe('2026-10-12T09:58:00Z');
    expect(query.get('exclude')).toBe('replies,retweets');
    expect(query.get('max_results')).toBe('20');
    expect(request?.authorization).toMatch(/^OAuth /);
  });

  it('returns read failures as values', async () => {
    expect(await client('down').listOwnPostsSince('42', new Date())).toMatchObject({
      kind: 'error',
    });
  });

  it('identifies the authenticated account', async () => {
    expect(await client('ok').getAccount()).toEqual({ id: '42', username: 'someone' });
    await expect(client('unauthorized').getAccount()).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});
