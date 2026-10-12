import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROMPT_TEMPLATES } from '../../src/config/load.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Fake credentials, assembled at runtime so that no credential-shaped literal
 * exists in the source (keeps `pnpm check:secrets` meaningful).
 */
export const fakeTelegramToken = (): string => `123456:${'T'.repeat(35)}`;
export const fakeOpenAiKey = (): string => `sk-test-${'k'.repeat(40)}`;
export const fakeXCredential = (label: string): string => `${label}-${'x'.repeat(30)}`;

export function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    TELEGRAM_BOT_TOKEN: fakeTelegramToken(),
    TELEGRAM_ALLOWED_USER_IDS: '111111',
    OPENAI_API_KEY: fakeOpenAiKey(),
    ...overrides,
  };
}

export const REAL_PROFILE: Readonly<Record<string, string>> = {
  'identity.md': '# Identity\n\nA test author.\n',
  'voice.md': '# Voice\n\nPlain and direct.\n',
  'facts.md': '# Facts\n\nWrites tests.\n',
  'opinions.md': '# Opinions\n\nTests are good.\n',
};

export interface ProjectFixture {
  root: string;
  write(relativePath: string, content: string): void;
  cleanup(): void;
}

/**
 * Temporary project root with prompt templates and, optionally, a config file,
 * a profile in local/profile, or a copy of the demo profile in examples/profile.
 */
export function createProjectFixture(
  options: {
    config?: string;
    profile?: Readonly<Record<string, string>>;
    demoProfile?: boolean;
    prompts?: boolean;
  } = {},
): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), 'x-agent-test-'));
  const write = (relativePath: string, content: string) => {
    const target = join(root, relativePath);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, content);
  };

  if (options.prompts ?? true) {
    for (const template of PROMPT_TEMPLATES) write(join('prompts', template), `# ${template}\n`);
  }
  if (options.config !== undefined) write('local/agent.yaml', options.config);
  for (const [file, content] of Object.entries(options.profile ?? {})) {
    write(join('local/profile', file), content);
  }
  if (options.demoProfile) {
    cpSync(join(REPO_ROOT, 'examples', 'profile'), join(root, 'examples', 'profile'), {
      recursive: true,
    });
  }

  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const MINIMAL_CONFIG = `
configVersion: 1
timezone: Africa/Abidjan
ai:
  enabled: true
  models: { ideas: test-model, drafting: test-model, evaluation: test-model }
`;
