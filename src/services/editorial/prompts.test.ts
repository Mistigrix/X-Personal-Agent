import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../tests/helpers/fixtures.ts';
import { stripMarkdownComments } from '../../domain/editorial/profile-context.ts';
import {
  createPromptTemplates,
  PromptRenderError,
  placeholdersOf,
  renderTemplate,
} from './prompts.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('renderTemplate', () => {
  it('replaces placeholders in a single pass', () => {
    expect(renderTemplate('Hi {{ name }}, {{name}}!', { name: '{{evil}}' })).toBe(
      'Hi {{evil}}, {{evil}}!',
    );
  });

  it('refuses to render with missing variables, listing them all', () => {
    expect(() => renderTemplate('{{a}} {{b}} {{c}}', { b: '' })).toThrow(
      new PromptRenderError('Missing prompt variables: a, c'),
    );
  });
});

/** The variables the editorial service provides; templates must use exactly these. */
const SERVICE_VARIABLES = {
  'generate-ideas': [
    'profile',
    'contentMix',
    'topicsFocus',
    'topicsAvoid',
    'allowedLanguages',
    'defaultLanguage',
    'languageGuidance',
    'recentTopics',
    'count',
  ],
  'generate-post': [
    'profile',
    'idea',
    'language',
    'maxWeightedLength',
    'maxHashtags',
    'maxEmojis',
    'bannedPhrases',
    'revisionNotes',
  ],
  'evaluate-post': ['profile', 'language', 'draft'],
};

describe('bundled prompt templates', () => {
  it.each(Object.entries(SERVICE_VARIABLES))(
    '%s uses exactly the variables the service provides',
    (name, variables) => {
      const template = stripMarkdownComments(
        readFileSync(join(REPO_ROOT, 'prompts', `${name}.md`), 'utf8'),
      );
      expect(placeholdersOf(template).sort()).toEqual([...variables].sort());
    },
  );
});

describe('createPromptTemplates', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'x-agent-prompts-'));
    directories.push(root);
    const promptsDir = join(root, 'prompts');
    const overridesDir = join(root, 'overrides');
    mkdirSync(promptsDir);
    mkdirSync(overridesDir);
    writeFileSync(join(promptsDir, 'evaluate-post.md'), '<!-- note -->\nDefault {{draft}}');
    return { templates: createPromptTemplates({ promptsDir, overridesDir }), overridesDir };
  }

  it('strips comments and prefers local overrides', () => {
    const { templates, overridesDir } = setup();
    const before = templates.render('evaluate-post', { draft: 'x' });
    expect(before.text).toBe('Default x');
    writeFileSync(join(overridesDir, 'evaluate-post.md'), 'Custom {{draft}}');
    const after = templates.render('evaluate-post', { draft: 'x' });
    expect(after.text).toBe('Custom x');
    expect(after.templateHash).not.toBe(before.templateHash);
  });

  it('reports a missing template', () => {
    const { templates } = setup();
    expect(() => templates.render('generate-post', {})).toThrow(PromptRenderError);
  });
});
