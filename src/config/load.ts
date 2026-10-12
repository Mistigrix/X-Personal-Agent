/**
 * Startup configuration: environment, behaviour config, editorial profile and
 * prompt templates, validated together so every problem is reported at once.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { type AppConfig, loadAppConfig } from './app-config.ts';
import {
  collectSecrets,
  DEFAULT_APP_CONFIG_PATH,
  DEFAULT_DATABASE_PATH,
  ENV_HINTS,
  ENV_SOURCE,
  type Env,
  parseEnv,
  X_CREDENTIAL_VARIABLES,
} from './env.ts';
import type { ConfigIssue } from './issues.ts';
import { type EditorialProfile, loadProfile } from './profile.ts';

export const PROMPT_TEMPLATES = [
  'generate-ideas.md',
  'generate-post.md',
  'evaluate-post.md',
] as const;

/** The bundled fictional profile. Used only when the config points at it explicitly. */
export const DEMO_PROFILE_DIR = 'examples/profile';

export interface ResolvedPaths {
  root: string;
  configFile: string;
  databaseFile: string;
  profileDir: string;
  promptsDir: string;
  promptOverridesDir: string;
}

export interface StartupConfig {
  env: Env;
  config: AppConfig;
  /** Null when AI generation is disabled. */
  profile: EditorialProfile | null;
  paths: ResolvedPaths;
  /** Credential values that must never appear in logs. */
  secrets: string[];
}

export type StartupConfigResult =
  | { ok: true; value: StartupConfig }
  | { ok: false; issues: ConfigIssue[] };

export interface LoadOptions {
  /** Project root; relative paths in env and config resolve against it. */
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Checks that an optional module can be loaded (overridable in tests). */
  canResolveModule?: (specifier: string) => boolean;
}

export function loadStartupConfig(options: LoadOptions): StartupConfigResult {
  const { root } = options;
  const canResolveModule = options.canResolveModule ?? defaultCanResolveModule;
  const display = (absolutePath: string) => toDisplayPath(root, absolutePath);
  const issues: ConfigIssue[] = [];

  const envResult = parseEnv(options.env);
  if (!envResult.ok) issues.push(...envResult.issues);

  // Cross-checks read raw values so they still run when another variable is
  // invalid: every problem is reported in a single pass.
  const rawValue = (name: string) => options.env[name]?.trim() || undefined;

  const configPath = resolve(root, rawValue('APP_CONFIG_PATH') ?? DEFAULT_APP_CONFIG_PATH);
  const configResult = loadAppConfig(configPath, display(configPath));
  if (!configResult.ok) issues.push(...configResult.issues);

  let profile: EditorialProfile | null = null;
  let paths: ResolvedPaths | null = null;

  if (configResult.ok) {
    const { config } = configResult;
    paths = {
      root,
      configFile: configPath,
      databaseFile: resolve(root, rawValue('DATABASE_PATH') ?? DEFAULT_DATABASE_PATH),
      profileDir: resolve(root, config.paths.profileDir),
      promptsDir: resolve(root, config.paths.promptsDir),
      promptOverridesDir: resolve(root, config.paths.promptOverridesDir),
    };

    if (config.ai.enabled) {
      const isDemo = paths.profileDir === resolve(root, DEMO_PROFILE_DIR);
      const profileResult = loadProfile(paths.profileDir, display(paths.profileDir), isDemo);
      if (profileResult.ok) profile = profileResult.profile;
      else issues.push(...profileResult.issues);

      issues.push(...checkPromptTemplates(paths, display));
    }
  }

  if (rawValue('PUBLISH_MODE') === 'live') {
    for (const variable of X_CREDENTIAL_VARIABLES) {
      if (rawValue(variable) === undefined) {
        issues.push({
          source: ENV_SOURCE,
          path: variable,
          message: 'is required when PUBLISH_MODE=live',
          hint: ENV_HINTS[variable],
        });
      }
    }
  }
  if (configResult.ok && configResult.config.ai.enabled && !rawValue('OPENAI_API_KEY')) {
    issues.push({
      source: ENV_SOURCE,
      path: 'OPENAI_API_KEY',
      message: 'is required when ai.enabled is true',
      hint: ENV_HINTS.OPENAI_API_KEY,
    });
  }
  if (rawValue('LOG_FORMAT') === 'pretty' && !canResolveModule('pino-pretty')) {
    issues.push({
      source: ENV_SOURCE,
      path: 'LOG_FORMAT',
      message: '"pretty" needs the pino-pretty dev dependency, which is not installed',
      hint: 'Use LOG_FORMAT=json in production, or install dev dependencies.',
    });
  }

  if (issues.length > 0 || !envResult.ok || !configResult.ok || paths === null) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      env: envResult.env,
      config: configResult.config,
      profile,
      paths,
      secrets: collectSecrets(envResult.env),
    },
  };
}

function checkPromptTemplates(
  paths: ResolvedPaths,
  display: (absolutePath: string) => string,
): ConfigIssue[] {
  return PROMPT_TEMPLATES.filter(
    (template) =>
      !existsSync(resolve(paths.promptOverridesDir, template)) &&
      !existsSync(resolve(paths.promptsDir, template)),
  ).map((template) => ({
    source: display(paths.promptsDir),
    path: template,
    message: 'prompt template is missing',
    hint: `Restore it from the repository (git checkout -- prompts/${template}), or place a custom version in ${display(paths.promptOverridesDir)}.`,
  }));
}

export function toDisplayPath(root: string, absolutePath: string): string {
  const relativePath = relative(root, absolutePath);
  return relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)
    ? absolutePath
    : relativePath;
}

function defaultCanResolveModule(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
