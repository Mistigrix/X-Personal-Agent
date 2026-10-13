/**
 * Contract test: the real OpenAI adapter (official SDK) against a local fake
 * Responses API. Checks the request we send and how each kind of answer is handled.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOpenAiClient } from '../src/integrations/openai/openai-client.ts';

let server: Server;
let baseUrl: string;
const bodies: Record<string, Record<string, unknown>> = {};

const schema = z.object({ text: z.string(), language: z.string() });

function responseWith(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1_760_000_000,
    status: 'completed',
    model: 'test-drafting-model',
    output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content }],
    usage: {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 1024 },
      output_tokens: 80,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 1280,
    },
    error: null,
    incomplete_details: null,
    ...extra,
  };
}

const outputText = (text: string) => ({ type: 'output_text', text, annotations: [] });

function handle(req: IncomingMessage, res: ServerResponse, body: string) {
  const scenario = (req.url ?? '').split('/')[1] ?? '';
  bodies[scenario] = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  switch (scenario) {
    case 'ok':
      return json(
        200,
        responseWith([outputText(JSON.stringify({ text: 'Hello', language: 'en' }))]),
      );
    case 'refusal':
      return json(200, responseWith([{ type: 'refusal', refusal: 'I cannot help with that.' }]));
    case 'incomplete':
      return json(
        200,
        responseWith([outputText('{"text": "Hel')], {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      );
    case 'mismatch':
      return json(200, responseWith([outputText(JSON.stringify({ text: 42 }))]));
    case 'unauthorized':
      return json(401, {
        error: {
          message: 'Incorrect API key provided.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    case 'missing-model':
      return json(404, {
        error: {
          message: 'The model `nope` does not exist.',
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
    case 'hang':
      return;
  }
  json(404, { error: { message: 'unknown scenario' } });
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

function client(scenario: string) {
  return createOpenAiClient({
    apiKey: `sk-test-${'k'.repeat(30)}`,
    models: {
      ideas: 'test-ideas-model',
      drafting: 'test-drafting-model',
      evaluation: 'test-evaluation-model',
    },
    reasoningEffort: 'medium',
    timeoutMs: 300,
    maxRetries: 0,
    baseURL: `${baseUrl}/${scenario}`,
  });
}

const request = {
  task: 'drafting' as const,
  instructions: 'Write the post. Profile: …',
  input: 'Write the post now.',
  schema,
  schemaName: 'post_draft',
};

describe('OpenAI adapter', () => {
  it('sends a Structured Outputs request that is not stored, and parses the answer', async () => {
    const result = await client('ok').generate(request);
    expect(result).toEqual({
      output: { text: 'Hello', language: 'en' },
      model: 'test-drafting-model',
      usage: { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 80 },
    });

    const body = bodies.ok ?? {};
    expect(body).toMatchObject({
      model: 'test-drafting-model',
      instructions: 'Write the post. Profile: …',
      input: 'Write the post now.',
      store: false,
      reasoning: { effort: 'medium' },
      prompt_cache_key: 'x-personal-agent-drafting',
    });
    expect(body.text).toMatchObject({
      format: {
        type: 'json_schema',
        name: 'post_draft',
        strict: true,
        schema: { type: 'object', additionalProperties: false, required: ['text', 'language'] },
      },
    });
  });

  it.each([
    ['refusal', 'refusal', 'The model refused: I cannot help with that.'],
    ['incomplete', 'incomplete', 'The model stopped before finishing (max_output_tokens).'],
    ['mismatch', 'invalid_output', undefined],
    ['unauthorized', 'auth', 'OpenAI rejected the API key (401). Check OPENAI_API_KEY in .env.'],
    ['missing-model', 'api_error', undefined],
    ['hang', 'timeout', undefined],
  ])('reports the "%s" answer as %s', async (scenario, code, message) => {
    const failure = client(scenario).generate(request);
    await expect(failure).rejects.toMatchObject({
      name: 'LlmError',
      code,
      ...(message ? { message } : {}),
    });
  });

  it('keeps the model error message for API errors (e.g. unknown model)', async () => {
    await expect(client('missing-model').generate(request)).rejects.toThrow(/does not exist/);
  });
});
