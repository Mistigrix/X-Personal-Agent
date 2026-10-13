/**
 * Port to a language model producing structured (schema-validated) output.
 * Model calls have no side effects, so retrying them is always safe.
 */
import type { z } from 'zod';

export type LlmTask = 'ideas' | 'drafting' | 'evaluation';

export interface LlmRequest<T> {
  task: LlmTask;
  /** Rendered prompt template. */
  instructions: string;
  /** Short request for this call. */
  input: string;
  /** Root must be an object schema (structured outputs requirement). */
  schema: z.ZodType<T>;
  schemaName: string;
}

export interface LlmUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  output: T;
  model: string;
  usage: LlmUsage;
}

export type LlmErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'refusal'
  | 'incomplete'
  | 'invalid_output'
  | 'api_error';

export class LlmError extends Error {
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

export interface LlmClient {
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

export function emptyUsage(): LlmUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

export function addUsage(total: LlmUsage, usage: LlmUsage): LlmUsage {
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
  };
}
