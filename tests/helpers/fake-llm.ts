import type { LlmClient, LlmRequest, LlmTask } from '../../src/integrations/openai/llm-client.ts';

type Scripted = unknown | Error | ((request: LlmRequest<unknown>) => unknown);

/**
 * Language model double: answers are scripted per task, validated against the
 * request schema (like Structured Outputs), and every request is recorded.
 */
export interface FakeLlm extends LlmClient {
  readonly requests: LlmRequest<unknown>[];
  respond(task: LlmTask, ...answers: Scripted[]): void;
  requestsFor(task: LlmTask): LlmRequest<unknown>[];
}

export function createFakeLlm(): FakeLlm {
  const queues: Record<LlmTask, Scripted[]> = { ideas: [], drafting: [], evaluation: [] };
  const fake: FakeLlm = {
    requests: [],
    respond(task, ...answers) {
      queues[task].push(...answers);
    },
    requestsFor: (task) => fake.requests.filter((request) => request.task === task),
    async generate<T>(request: LlmRequest<T>) {
      fake.requests.push(request as LlmRequest<unknown>);
      if (queues[request.task].length === 0)
        throw new Error(`No scripted answer for ${request.task}`);
      const next = queues[request.task].shift();
      if (next instanceof Error) throw next;
      // Scripted functions may return a promise (to simulate a slow model).
      const raw = await (typeof next === 'function'
        ? (next as (r: LlmRequest<unknown>) => unknown)(request as LlmRequest<unknown>)
        : next);
      return {
        output: request.schema.parse(raw),
        model: `fake-${request.task}`,
        usage: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100 },
      };
    },
  };
  return fake;
}

/** A draft answer that passes every check by default. */
export function draftAnswer(text: string, overrides: Record<string, unknown> = {}) {
  return { text, language: 'en', claims: [], ...overrides };
}

/** An evaluation answer recommending to keep the draft. */
export function keepEvaluation(overrides: Record<string, unknown> = {}) {
  return {
    voice: 4,
    value: 4,
    clarity: 5,
    claims: [],
    issues: [],
    recommendation: 'keep',
    ...overrides,
  };
}
