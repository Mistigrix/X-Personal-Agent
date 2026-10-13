/**
 * Guards for publishing this repository publicly: private data must be ignored by
 * git, and committed examples must contain only placeholders and fictional data.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isPrivatePath } from '../scripts/private-paths.ts';
import { EXAMPLE_PROFILE_MARKER } from '../src/config/profile.ts';
import { REPO_ROOT } from './helpers/fixtures.ts';

function isIgnoredByGit(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

const PRIVATE_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  'local/agent.yaml',
  'local/profile/identity.md',
  'local/prompts/generate-post.md',
  'local/data/agent.db',
  'local/data/agent.db-wal',
  'backups/agent-2026-10-12.db',
  'agent.sqlite',
  'logs/agent.log',
];

const PUBLIC_PATHS = [
  '.env.example',
  'config/agent.example.yaml',
  'examples/profile/identity.md',
  'prompts/generate-post.md',
  'drizzle/0000_initial_schema.sql',
];

function insideGitRepository(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// A source archive (e.g. a ZIP download) has no git metadata to check against.
describe.skipIf(!insideGitRepository())('.gitignore', () => {
  it.each(PRIVATE_PATHS)('ignores %s', (path) => {
    expect(isIgnoredByGit(path)).toBe(true);
  });

  it.each(PUBLIC_PATHS)('keeps %s committable', (path) => {
    expect(isIgnoredByGit(path)).toBe(false);
  });
});

describe('isPrivatePath (check:secrets second line of defence)', () => {
  it.each(PRIVATE_PATHS.filter((path) => !path.startsWith('logs/')))('flags %s', (path) => {
    expect(isPrivatePath(path)).toBe(true);
  });

  it.each(PUBLIC_PATHS)('allows %s', (path) => {
    expect(isPrivatePath(path)).toBe(false);
  });
});

describe('committed examples', () => {
  it('.env.example contains no credential values', () => {
    const env = parseEnv(readFileSync(join(REPO_ROOT, '.env.example'), 'utf8'));
    for (const name of [
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_ALLOWED_USER_IDS',
      'OPENAI_API_KEY',
      'X_API_KEY',
      'X_API_SECRET',
      'X_ACCESS_TOKEN',
      'X_ACCESS_TOKEN_SECRET',
    ]) {
      expect(env[name], name).toBe('');
    }
    expect(env.PUBLISH_MODE).toBe('dry-run');
  });

  it('marks every example profile file as fictional', () => {
    const directory = join(REPO_ROOT, 'examples/profile');
    const files = readdirSync(directory).filter((file) => file.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      expect(readFileSync(join(directory, file), 'utf8'), file).toContain(
        `<!-- ${EXAMPLE_PROFILE_MARKER}`,
      );
    }
  });
});
