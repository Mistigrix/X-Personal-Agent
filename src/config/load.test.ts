import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectFixture,
  fakeOpenAiKey,
  fakeTelegramToken,
  fakeXCredential,
  MINIMAL_CONFIG,
  type ProjectFixture,
  REAL_PROFILE,
  REPO_ROOT,
  validEnv,
} from '../../tests/helpers/fixtures.ts';
import { renderConfigIssues } from './issues.ts';
import { type LoadOptions, loadStartupConfig } from './load.ts';

let fixture: ProjectFixture | undefined;
afterEach(() => fixture?.cleanup());

function load(
  setup: Parameters<typeof createProjectFixture>[0],
  env: Record<string, string | undefined> = validEnv(),
  extra: Partial<LoadOptions> = {},
) {
  fixture = createProjectFixture(setup);
  return loadStartupConfig({ root: fixture.root, env, canResolveModule: () => true, ...extra });
}

const AI_DISABLED_CONFIG = MINIMAL_CONFIG.replace('enabled: true', 'enabled: false');
const DEMO_CONFIG = `${MINIMAL_CONFIG}paths:\n  profileDir: ./examples/profile\n`;

describe('loadStartupConfig', () => {
  it('loads a complete valid setup with resolved paths and secrets', () => {
    const result = load({ config: MINIMAL_CONFIG, profile: REAL_PROFILE });
    expect(result.ok).toBe(true);
    if (!result.ok || !fixture) return;
    const { value } = result;
    expect(value.profile?.isDemo).toBe(false);
    expect(value.paths.databaseFile).toBe(join(fixture.root, 'local/data/agent.db'));
    expect(value.paths.profileDir).toBe(join(fixture.root, 'local/profile'));
    expect(value.secrets.sort()).toEqual([fakeOpenAiKey(), fakeTelegramToken()].sort());
  });

  it('reports problems from every source at once', () => {
    const result = load({ profile: REAL_PROFILE }, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => [issue.source, issue.path])).toEqual([
      ['.env', 'TELEGRAM_BOT_TOKEN'],
      ['.env', 'TELEGRAM_ALLOWED_USER_IDS'],
      ['local/agent.yaml', undefined],
    ]);
  });

  it('still runs cross-checks when another variable is invalid', () => {
    const result = load(
      { config: MINIMAL_CONFIG, profile: REAL_PROFILE },
      { TELEGRAM_ALLOWED_USER_IDS: 'not-a-number', PUBLISH_MODE: 'live' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_ALLOWED_USER_IDS',
      'X_API_KEY',
      'X_API_SECRET',
      'X_ACCESS_TOKEN',
      'X_ACCESS_TOKEN_SECRET',
      'OPENAI_API_KEY',
    ]);
  });

  it('needs neither an OpenAI key nor a profile when AI is disabled', () => {
    const result = load({ config: AI_DISABLED_CONFIG }, validEnv({ OPENAI_API_KEY: undefined }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile).toBeNull();
  });

  it('requires the OpenAI key, profile and prompts when AI is enabled', () => {
    const result = load(
      { config: MINIMAL_CONFIG, prompts: false },
      validEnv({ OPENAI_API_KEY: undefined }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const located = result.issues.map((issue) => `${issue.source}:${issue.path}`);
    expect(located).toEqual(
      expect.arrayContaining([
        '.env:OPENAI_API_KEY',
        'local/profile:identity.md',
        'prompts:generate-post.md',
      ]),
    );
  });

  it('accepts prompt templates provided only as local overrides', () => {
    const result = load({ config: MINIMAL_CONFIG, profile: REAL_PROFILE, prompts: false });
    expect(result.ok).toBe(false);
    if (!fixture) return;
    for (const template of ['generate-ideas.md', 'generate-post.md', 'evaluate-post.md']) {
      fixture.write(join('local/prompts', template), 'custom');
    }
    const retry = loadStartupConfig({
      root: fixture.root,
      env: validEnv(),
      canResolveModule: () => true,
    });
    expect(retry.ok).toBe(true);
  });

  it('never uses copied example content as a real profile', () => {
    fixture = createProjectFixture({ config: MINIMAL_CONFIG, demoProfile: true });
    const exampleFiles = ['identity.md', 'voice.md', 'facts.md', 'opinions.md'];
    for (const file of exampleFiles) {
      fixture.write(
        join('local/profile', file),
        readFileSync(join(REPO_ROOT, 'examples/profile', file), 'utf8'),
      );
    }
    const result = loadStartupConfig({
      root: fixture.root,
      env: validEnv(),
      canResolveModule: () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(exampleFiles.length);
    expect(result.issues.every((issue) => issue.message.includes('fictional example'))).toBe(true);
  });

  it('allows the demo profile only when the config points at it explicitly', () => {
    const result = load({ config: DEMO_CONFIG, demoProfile: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile?.isDemo).toBe(true);
  });

  it('requires all X credentials in live mode', () => {
    const result = load(
      { config: AI_DISABLED_CONFIG },
      validEnv({ PUBLISH_MODE: 'live', X_API_KEY: fakeXCredential('key') }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      'X_API_SECRET',
      'X_ACCESS_TOKEN',
      'X_ACCESS_TOKEN_SECRET',
    ]);
  });

  it('accepts live mode with complete X credentials', () => {
    const result = load(
      { config: AI_DISABLED_CONFIG },
      validEnv({
        PUBLISH_MODE: 'live',
        X_API_KEY: fakeXCredential('key'),
        X_API_SECRET: fakeXCredential('secret'),
        X_ACCESS_TOKEN: fakeXCredential('token'),
        X_ACCESS_TOKEN_SECRET: fakeXCredential('token-secret'),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.secrets).toHaveLength(6);
  });

  it('rejects pretty logs when pino-pretty is not installed', () => {
    const result = load({ config: AI_DISABLED_CONFIG }, validEnv({ LOG_FORMAT: 'pretty' }), {
      canResolveModule: () => false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([expect.objectContaining({ path: 'LOG_FORMAT' })]);
  });

  it('honours APP_CONFIG_PATH even when other variables are invalid', () => {
    fixture = createProjectFixture({ config: MINIMAL_CONFIG });
    rmSync(join(fixture.root, 'local/agent.yaml'));
    fixture.write('custom/agent.yaml', AI_DISABLED_CONFIG);
    const result = loadStartupConfig({
      root: fixture.root,
      env: { APP_CONFIG_PATH: './custom/agent.yaml' },
      canResolveModule: () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.every((issue) => issue.source === '.env')).toBe(true);
  });
});

describe('renderConfigIssues', () => {
  it('groups issues by source with fix hints and no secret values', () => {
    const malformedToken = `bad-token-${'z'.repeat(20)}`;
    const result = load(
      { config: 'configVersion: 2\n' },
      validEnv({ TELEGRAM_BOT_TOKEN: malformedToken }),
    );
    if (result.ok) throw new Error('expected invalid configuration');
    const output = renderConfigIssues(result.issues);
    expect(output).toContain('The agent did not start.');
    expect(output).toMatch(/\.env\n {2}- TELEGRAM_BOT_TOKEN: .+\n {4}Fix: .*@BotFather/);
    expect(output).toContain('local/agent.yaml\n  - configVersion: must be 1');
    expect(output).toContain('  - timezone: is required');
    expect(output).not.toContain(malformedToken);
  });
});
