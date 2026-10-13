/**
 * Editorial profile: Markdown files describing the author, read from a local,
 * gitignored directory. The AI may only state what these files contain.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripMarkdownComments } from '../domain/editorial/profile-context.ts';
import type { ConfigIssue } from './issues.ts';

export { stripMarkdownComments };

export const PROFILE_SECTIONS = {
  identity: { file: 'identity.md', required: true, purpose: 'who you are professionally' },
  voice: { file: 'voice.md', required: true, purpose: 'your tone, style and vocabulary' },
  facts: {
    file: 'facts.md',
    required: true,
    purpose: 'verified facts the AI may state about you',
  },
  opinions: {
    file: 'opinions.md',
    required: true,
    purpose: 'opinions you actually hold and want to express',
  },
  projects: { file: 'projects.md', required: false, purpose: 'your current projects' },
  examples: { file: 'examples.md', required: false, purpose: 'posts you wrote, as style examples' },
  rules: { file: 'rules.md', required: false, purpose: 'editorial rules and restrictions' },
} as const;

export type ProfileSection = keyof typeof PROFILE_SECTIONS;

/**
 * Marker present in every file of the fictional example profile. A real profile
 * must not contain it, so example content is never mistaken for the user's own.
 */
export const EXAMPLE_PROFILE_MARKER = 'example-profile';
const EXAMPLE_MARKER_PATTERN = new RegExp(`<!--\\s*${EXAMPLE_PROFILE_MARKER}\\b`);

export interface EditorialProfile {
  directory: string;
  /** True when explicitly running with the fictional demo profile. */
  isDemo: boolean;
  /** Raw Markdown per section (comments included); null for absent optional files. */
  sections: Record<ProfileSection, string | null>;
}

export type ProfileResult =
  | { ok: true; profile: EditorialProfile }
  | { ok: false; issues: ConfigIssue[] };

/**
 * @param directory absolute path of the profile directory
 * @param displayPath path shown in error messages
 * @param isDemo whether this is the bundled fictional demo profile (example marker allowed)
 */
export function loadProfile(
  directory: string,
  displayPath: string,
  isDemo: boolean,
): ProfileResult {
  const issues: ConfigIssue[] = [];
  const sections = {} as Record<ProfileSection, string | null>;
  const setupHint = `In a local checkout, run \`pnpm init:local\` and rewrite each copied file. In Docker or Dokploy, mount your profile files in ${directory}/ and redeploy. Or set ai.enabled: false.`;

  for (const [name, spec] of Object.entries(PROFILE_SECTIONS) as [
    ProfileSection,
    (typeof PROFILE_SECTIONS)[ProfileSection],
  ][]) {
    let content: string | null = null;
    try {
      content = readFileSync(join(directory, spec.file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        issues.push({ source: displayPath, path: spec.file, message: 'file could not be read' });
      } else if (spec.required) {
        issues.push({
          source: displayPath,
          path: spec.file,
          message: `is missing (it should describe ${spec.purpose})`,
          hint: setupHint,
        });
      }
    }

    if (content !== null) {
      if (!isDemo && EXAMPLE_MARKER_PATTERN.test(content)) {
        issues.push({
          source: displayPath,
          path: spec.file,
          message: 'still contains the fictional example content',
          hint: `Rewrite it with your own information (${spec.purpose}), then delete the \`<!-- ${EXAMPLE_PROFILE_MARKER} ... -->\` line.${spec.required ? '' : ' This file is optional: you can also delete it.'}`,
        });
      } else if (spec.required && stripMarkdownComments(content).trim() === '') {
        issues.push({
          source: displayPath,
          path: spec.file,
          message: `is empty (it should describe ${spec.purpose})`,
        });
      }
    }
    sections[name] = content;
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, profile: { directory, isDemo, sections } };
}
