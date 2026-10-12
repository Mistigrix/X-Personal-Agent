import { type DestinationStream, type Logger, pino } from 'pino';
import { createSecretScrubber, REDACTED } from './redact.ts';

export type { Logger };

export interface LoggerOptions {
  level: string;
  format: 'json' | 'pretty';
  /** Credential values scrubbed from every log line, wherever they appear. */
  secrets: readonly string[];
  /** Custom destination (tests). Not combinable with the pretty format. */
  destination?: DestinationStream;
}

/** Field names that never get logged, whatever object they appear in. */
const REDACTED_PATHS = [
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'apiSecret',
  '*.apiSecret',
  'accessToken',
  '*.accessToken',
  'accessTokenSecret',
  '*.accessTokenSecret',
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'headers.cookie',
  '*.headers.cookie',
];

/**
 * Structured JSON logger. Conventions: log public IDs, never post text at info
 * level, never credentials (redacted by key and scrubbed by value).
 */
export function createLogger(options: LoggerOptions): Logger {
  const scrub = createSecretScrubber(options.secrets);
  const pinoOptions = {
    level: options.level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: REDACTED },
    hooks: { streamWrite: scrub },
  };

  if (options.destination) return pino(pinoOptions, options.destination);
  if (options.format === 'pretty') {
    return pino({
      ...pinoOptions,
      transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } },
    });
  }
  return pino(pinoOptions);
}
