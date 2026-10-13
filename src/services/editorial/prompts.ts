/**
 * Prompt templates: Markdown files with `{{placeholders}}`. A file in the local
 * overrides directory replaces the default one. Rendering fails if any
 * placeholder has no value, so a broken prompt is never sent.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripMarkdownComments } from '../../domain/editorial/profile-context.ts';

export type PromptName = 'generate-ideas' | 'generate-post' | 'evaluate-post';

export interface RenderedPrompt {
  text: string;
  /** Short hash of the template used, recorded with each generated draft. */
  templateHash: string;
}

export class PromptRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptRenderError';
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;

/** Placeholders used by a template. */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))];
}

/** Replaces every placeholder in one pass (values are never re-scanned). */
export function renderTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  const missing = placeholdersOf(template).filter((name) => !(name in variables));
  if (missing.length > 0) {
    throw new PromptRenderError(`Missing prompt variables: ${missing.join(', ')}`);
  }
  return template.replace(PLACEHOLDER, (_match, name: string) => variables[name] ?? '');
}

export interface PromptTemplates {
  render(name: PromptName, variables: Readonly<Record<string, string>>): RenderedPrompt;
}

export function createPromptTemplates(options: {
  promptsDir: string;
  overridesDir: string;
}): PromptTemplates {
  function read(name: PromptName): string {
    for (const directory of [options.overridesDir, options.promptsDir]) {
      try {
        return readFileSync(join(directory, `${name}.md`), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new PromptRenderError(`Prompt template ${name}.md not found`);
  }

  return {
    render(name, variables) {
      // Read on every call so edits to the templates apply without a restart.
      const template = stripMarkdownComments(read(name)).trim();
      return {
        text: renderTemplate(template, variables),
        templateHash: createHash('sha256').update(template).digest('hex').slice(0, 12),
      };
    },
  };
}
