import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Reads `<root>/.env` if it exists. Real environment variables take precedence
 * over the file (so Docker/systemd settings win), and process.env is not mutated.
 */
export function readEnvironment(
  root: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  let fileVariables: Record<string, string | undefined> = {};
  try {
    fileVariables = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { ...fileVariables, ...processEnv };
}
