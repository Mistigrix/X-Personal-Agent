/**
 * OpenAI adapter: Responses API with Structured Outputs (Zod), `store: false`.
 */
import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { type LlmClient, LlmError, type LlmTask } from './llm-client.ts';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof APIUserAbortError)
    return new LlmError('aborted', 'The request was cancelled.');
  if (error instanceof AuthenticationError) {
    return new LlmError('auth', 'OpenAI rejected the API key (401). Check OPENAI_API_KEY in .env.');
  }
  if (error instanceof RateLimitError) {
    return new LlmError('rate_limited', `OpenAI rate limit or quota reached: ${error.message}`);
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new LlmError(
      'timeout',
      'OpenAI did not answer before the timeout (ai.requestTimeoutSeconds).',
    );
  }
  if (error instanceof APIError) {
    return new LlmError(
      'api_error',
      `OpenAI error${error.status ? ` ${error.status}` : ''}: ${error.message}`,
    );
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return new LlmError('invalid_output', 'The model output did not match the expected structure.');
  }
  return new LlmError('api_error', error instanceof Error ? error.message : String(error));
}

export function createOpenAiClient(options: {
  apiKey: string;
  models: Readonly<Record<LlmTask, string>>;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  /** SDK retries for transient errors (safe: model calls have no side effects). */
  maxRetries?: number;
  /** Override for tests (local fake server). */
  baseURL?: string;
}): LlmClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries ?? 2,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  return {
    async generate(request) {
      let response: Awaited<ReturnType<typeof client.responses.parse>>;
      try {
        response = await client.responses.parse(
          {
            model: options.models[request.task],
            instructions: request.instructions,
            input: request.input,
            text: {
              format: zodTextFormat(request.schema as z.ZodType<object>, request.schemaName),
            },
            reasoning: { effort: options.reasoningEffort },
            // Drafts and the editorial profile are not kept by OpenAI for later retrieval.
            store: false,
            // Same prefix (template + profile) per task: helps OpenAI reuse its prompt cache.
            prompt_cache_key: `x-personal-agent-${request.task}`,
          },
          request.signal ? { signal: request.signal } : undefined,
        );
      } catch (error) {
        throw toLlmError(error);
      }

      if (response.status === 'incomplete') {
        const reason = response.incomplete_details?.reason ?? 'unknown reason';
        throw new LlmError('incomplete', `The model stopped before finishing (${reason}).`);
      }
      for (const item of response.output) {
        if (item.type !== 'message') continue;
        for (const content of item.content) {
          if (content.type === 'refusal') {
            throw new LlmError('refusal', `The model refused: ${content.refusal}`);
          }
        }
      }
      if (response.output_parsed === null || response.output_parsed === undefined) {
        throw new LlmError('invalid_output', 'The model returned no usable output.');
      }

      // Re-validate with the caller's schema to obtain its exact type.
      const parsed = request.schema.safeParse(response.output_parsed);
      if (!parsed.success) {
        throw new LlmError(
          'invalid_output',
          'The model output did not match the expected structure.',
        );
      }
      return {
        output: parsed.data,
        model: response.model,
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}
