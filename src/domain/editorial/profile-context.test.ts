import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../tests/helpers/fixtures.ts';
import { loadProfile } from '../../config/profile.ts';
import { buildProfileContext, parseExamplePosts } from './profile-context.ts';

const SECTIONS = {
  identity: '<!-- guidance -->\nA developer.',
  voice: 'Direct.',
  facts: 'Built 3 apps.',
  opinions: 'SQLite is underrated.',
  projects: null,
  examples: 'First post.\n---\nSecond post.\n\n---\n',
  rules: '   ',
};

describe('buildProfileContext', () => {
  it('labels each section with what the model may do with it', () => {
    const context = buildProfileContext(SECTIONS);
    expect(context).toContain(
      '### VERIFIED FACTS\n(True statements about the author. Only these may be stated as facts about the author.)\n\nBuilt 3 apps.',
    );
    expect(context).toContain("### OPINIONS\n(The author's actual views.");
    expect(context).toContain('Example 1:\nFirst post.\n\nExample 2:\nSecond post.');
    expect(context).toContain('Never copy or closely paraphrase them.');
  });

  it('drops guidance comments and empty or absent sections', () => {
    const context = buildProfileContext(SECTIONS);
    expect(context).not.toContain('guidance');
    expect(context).not.toContain('CURRENT PROJECTS');
    expect(context).not.toContain('EDITORIAL RULES');
  });

  it('orders facts before opinions and examples last', () => {
    const context = buildProfileContext(SECTIONS);
    expect(context.indexOf('IDENTITY')).toBeLessThan(context.indexOf('VERIFIED FACTS'));
    expect(context.indexOf('VERIFIED FACTS')).toBeLessThan(context.indexOf('OPINIONS'));
    expect(context.indexOf('POSTS WRITTEN BY THE AUTHOR')).toBeGreaterThan(
      context.indexOf('VOICE AND STYLE'),
    );
  });

  it('builds a context from the bundled demo profile without its markers', () => {
    const result = loadProfile(join(REPO_ROOT, 'examples/profile'), 'examples/profile', true);
    if (!result.ok) throw new Error('demo profile should load');
    const context = buildProfileContext(result.profile.sections);
    expect(context).toContain('Jordan Example');
    expect(context).not.toContain('example-profile');
    expect(parseExamplePosts(result.profile.sections.examples ?? '')).toHaveLength(4);
  });
});
