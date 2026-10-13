import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createProjectFixture,
  MINIMAL_CONFIG,
  type ProjectFixture,
  REPO_ROOT,
} from '../../tests/helpers/fixtures.ts';
import { appConfigSchema, loadAppConfig } from './app-config.ts';

let fixture: ProjectFixture | undefined;
afterEach(() => fixture?.cleanup());

function load(yaml: string) {
  fixture = createProjectFixture({ config: yaml });
  return loadAppConfig(join(fixture.root, 'local/agent.yaml'), 'local/agent.yaml');
}

function issuesOf(yaml: string) {
  const result = load(yaml);
  if (result.ok) throw new Error('expected invalid config');
  return result.issues;
}

describe('loadAppConfig', () => {
  it('accepts the committed example config', () => {
    const result = loadAppConfig(join(REPO_ROOT, 'config/agent.example.yaml'), 'example');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timezone).toBe('Africa/Abidjan');
    expect(result.config.schedule.postsPerDay).toBe(3);
  });

  it('fills defaults for omitted sections', () => {
    const result = load(MINIMAL_CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.schedule.windows).toHaveLength(3);
    expect(result.config.publishing.maxWeightedLength).toBe(280);
    expect(result.config.publishing.urlPolicy).toBe('confirm');
    expect(result.config.publishing.reconcile.autoRetryIfNotFound).toBe(false);
    expect(result.config.telegram.confirmPersonalPosts).toBe(true);
    expect(result.config.editorial.languages).toEqual({
      default: 'en',
      allowed: ['en'],
      guidance: '',
    });
    expect(result.config.paths.profileDir).toBe('./local/profile');
  });

  it('flags unknown keys so typos do not pass silently', () => {
    expect(issuesOf(`${MINIMAL_CONFIG}schedule:\n  postPerDay: 2\n`)).toEqual([
      expect.objectContaining({
        path: 'schedule.postPerDay',
        message: expect.stringContaining('not a recognized'),
      }),
    ]);
  });

  it('requires enough windows for the daily target', () => {
    const yaml = `${MINIMAL_CONFIG}schedule:\n  postsPerDay: 3\n  windows:\n    - { start: "08:00", end: "10:00" }\n`;
    expect(issuesOf(yaml)).toEqual([expect.objectContaining({ path: 'schedule.postsPerDay' })]);
  });

  it('rejects overlapping or unordered windows', () => {
    const yaml = `${MINIMAL_CONFIG}schedule:\n  postsPerDay: 2\n  windows:\n    - { start: "08:00", end: "10:00" }\n    - { start: "09:00", end: "11:00" }\n`;
    expect(issuesOf(yaml)).toEqual([expect.objectContaining({ path: 'schedule.windows[1]' })]);
  });

  it('rejects windows too close to respect the minimum gap', () => {
    const yaml = `${MINIMAL_CONFIG}schedule:\n  postsPerDay: 2\n  minGapMinutes: 180\n  windows:\n    - { start: "08:00", end: "09:00" }\n    - { start: "09:00", end: "10:00" }\n`;
    expect(issuesOf(yaml)).toEqual([expect.objectContaining({ path: 'schedule.windows[1]' })]);
  });

  it('rejects malformed times and windows crossing midnight', () => {
    const yaml = `${MINIMAL_CONFIG}schedule:\n  postsPerDay: 1\n  windows:\n    - { start: "8:00", end: "25:00" }\n`;
    const paths = issuesOf(yaml).map((issue) => issue.path);
    expect(paths).toEqual(['schedule.windows[0].start', 'schedule.windows[0].end']);
  });

  it('rejects an unknown timezone', () => {
    expect(issuesOf(MINIMAL_CONFIG.replace('Africa/Abidjan', 'Mars/Olympus'))).toEqual([
      expect.objectContaining({ path: 'timezone' }),
    ]);
  });

  it('requires the default language to be allowed', () => {
    const yaml = `${MINIMAL_CONFIG}editorial:\n  languages: { default: fr, allowed: [en] }\n`;
    expect(issuesOf(yaml)).toEqual([
      expect.objectContaining({ path: 'editorial.languages.default' }),
    ]);
  });

  it('reports YAML syntax errors with a line number', () => {
    const [issue] = issuesOf('configVersion: 1\ntimezone: [unclosed\n');
    expect(issue?.message).toMatch(/^YAML syntax error/);
    expect(issue?.path).toMatch(/^line \d+$/);
  });

  it('reports an empty file', () => {
    expect(issuesOf('# only a comment\n')).toEqual([
      expect.objectContaining({ message: 'file is empty' }),
    ]);
  });

  it('explains how to create a missing file', () => {
    const result = loadAppConfig('/nonexistent/agent.yaml', 'local/agent.yaml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The absolute path tells container users exactly where to mount the file.
    expect(result.issues[0]?.message).toBe('file not found (looked for /nonexistent/agent.yaml)');
    expect(result.issues[0]?.hint).toContain('pnpm init:local');
    expect(result.issues[0]?.hint).toContain('mount your config file at /nonexistent/agent.yaml');
  });
});

describe('hard safety invariants', () => {
  it('offers no setting that could disable approval of AI posts', () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(appConfigSchema, { unrepresentable: 'any' }));
    expect(jsonSchema).not.toMatch(/approv/i);
  });
});
