import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectFixture,
  type ProjectFixture,
  REAL_PROFILE,
  REPO_ROOT,
} from '../../tests/helpers/fixtures.ts';
import { loadProfile, stripMarkdownComments } from './profile.ts';

let fixture: ProjectFixture | undefined;
afterEach(() => fixture?.cleanup());

function loadFixtureProfile(files: Record<string, string>) {
  fixture = createProjectFixture({ profile: files });
  return loadProfile(join(fixture.root, 'local/profile'), 'local/profile', false);
}

describe('loadProfile', () => {
  it('loads required sections and leaves absent optional ones null', () => {
    const result = loadFixtureProfile({ ...REAL_PROFILE, 'rules.md': 'Be kind.' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.isDemo).toBe(false);
    expect(result.profile.sections.identity).toContain('A test author.');
    expect(result.profile.sections.rules).toBe('Be kind.');
    expect(result.profile.sections.projects).toBeNull();
  });

  it('lists every missing required file', () => {
    fixture = createProjectFixture();
    const result = loadProfile(join(fixture.root, 'local/profile'), 'local/profile', false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      'identity.md',
      'voice.md',
      'facts.md',
      'opinions.md',
    ]);
    expect(result.issues[0]?.hint).toContain('pnpm init:local');
  });

  it('treats a file containing only comments as empty', () => {
    const result = loadFixtureProfile({
      ...REAL_PROFILE,
      'voice.md': '<!-- describe your voice -->\n\n',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({ path: 'voice.md', message: expect.stringContaining('is empty') }),
    ]);
  });

  it('refuses fictional example content outside the demo profile', () => {
    const result = loadFixtureProfile({
      ...REAL_PROFILE,
      'facts.md': '<!-- example-profile: fictional -->\nJordan Example\n',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: 'facts.md',
        message: expect.stringContaining('fictional example'),
      }),
    ]);
  });

  it('accepts the bundled demo profile when explicitly running in demo mode', () => {
    const result = loadProfile(join(REPO_ROOT, 'examples/profile'), 'examples/profile', true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.isDemo).toBe(true);
    expect(Object.values(result.profile.sections).every((section) => section !== null)).toBe(true);
  });
});

describe('stripMarkdownComments', () => {
  it('removes single and multi-line comments', () => {
    expect(stripMarkdownComments('a<!-- x -->b<!--\ny\n-->c')).toBe('abc');
  });
});
