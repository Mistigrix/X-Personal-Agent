import type { z } from 'zod';

/** Exit code for invalid configuration (EX_CONFIG from sysexits.h). */
export const CONFIG_ERROR_EXIT_CODE = 78;

/**
 * A configuration problem, phrased so the user can fix it without reading code.
 * Messages must never contain secret values.
 */
export interface ConfigIssue {
  /** The file or area containing the problem, e.g. `.env`, `local/agent.yaml`. */
  source: string;
  /** Key or file inside the source, e.g. `TELEGRAM_BOT_TOKEN`, `schedule.windows[1].start`. */
  path?: string;
  message: string;
  hint?: string;
}

export function formatIssuePath(path: readonly PropertyKey[]): string {
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += `[${segment}]`;
    } else {
      result += result === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return result;
}

/**
 * Converts Zod issues into ConfigIssues. Zod's default messages describe types and
 * expectations, not received values, so no secret can leak through them.
 */
export function fromZodError(
  error: z.ZodError,
  source: string,
  hints: Readonly<Record<string, string>> = {},
): ConfigIssue[] {
  return error.issues.flatMap((issue): ConfigIssue[] => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        source,
        path: formatIssuePath([...issue.path, key]),
        message: 'is not a recognized setting (check for a typo or wrong indentation)',
      }));
    }
    const result: ConfigIssue = { source, message: issue.message };
    const path = formatIssuePath(issue.path);
    if (path) result.path = path;
    const topLevelKey = issue.path[0];
    const hint = typeof topLevelKey === 'string' ? hints[topLevelKey] : undefined;
    if (hint) result.hint = hint;
    return [result];
  });
}

export function renderConfigIssues(issues: readonly ConfigIssue[]): string {
  const bySource = new Map<string, ConfigIssue[]>();
  for (const issue of issues) {
    const list = bySource.get(issue.source) ?? [];
    list.push(issue);
    bySource.set(issue.source, list);
  }

  const count = issues.length === 1 ? '1 problem' : `${issues.length} problems`;
  const lines = [`Configuration is invalid (${count}). The agent did not start.`, ''];
  for (const [source, sourceIssues] of bySource) {
    lines.push(source);
    for (const issue of sourceIssues) {
      lines.push(`  - ${issue.path ? `${issue.path}: ` : ''}${issue.message}`);
      if (issue.hint) lines.push(`    Fix: ${issue.hint}`);
    }
    lines.push('');
  }
  lines.push('Fix the problems above, then start the agent again. See README.md > Configuration.');
  return `${lines.join('\n')}\n`;
}
