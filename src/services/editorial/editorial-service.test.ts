import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { postState } from '../../../tests/helpers/db.ts';
import {
  createFakeLlm,
  draftAnswer,
  type FakeLlm,
  keepEvaluation,
} from '../../../tests/helpers/fake-llm.ts';
import { REPO_ROOT } from '../../../tests/helpers/fixtures.ts';
import {
  createTestServices,
  silentLogger,
  type TestServices,
} from '../../../tests/helpers/services.ts';
import { loadProfile } from '../../config/profile.ts';
import { buildProfileContext } from '../../domain/editorial/profile-context.ts';
import { contentHash } from '../../domain/text.ts';
import { LlmError } from '../../integrations/openai/llm-client.ts';
import {
  createEditorialService,
  type EditorialService,
  type EditorialSettings,
} from './editorial-service.ts';
import { createPromptTemplates } from './prompts.ts';

const SETTINGS: EditorialSettings = {
  ideasPerRequest: 3,
  maxRegenerations: 2,
  contentMix: { technical: 1, opinion: 1 },
  topicsFocus: ['web development'],
  defaultLanguage: 'en',
  languageGuidance: '',
  lookbackPosts: 50,
  topicCooldownDays: 3,
  draftRules: {
    text: { maxWeightedLength: 280, urlPolicy: 'confirm' },
    bannedPhrases: ['game-changer'],
    maxHashtags: 1,
    maxEmojis: 2,
    allowedLanguages: ['en', 'fr'],
    avoidTopics: ['politics'],
    nearDuplicateThreshold: 0.8,
  },
};

function demoProfile(): string {
  const result = loadProfile(join(REPO_ROOT, 'examples/profile'), 'examples/profile', true);
  if (!result.ok) throw new Error('demo profile should load');
  return buildProfileContext(result.profile.sections);
}

interface Setup {
  s: TestServices;
  llm: FakeLlm;
  editorial: EditorialService;
}

const opened: TestServices[] = [];
afterEach(() => {
  for (const created of opened.splice(0)) created.handle.close();
});

function setup(settings: Partial<EditorialSettings> = {}): Setup {
  const s = createTestServices();
  opened.push(s);
  const llm = createFakeLlm();
  const editorial = createEditorialService({
    db: s.db,
    llm,
    prompts: createPromptTemplates({
      promptsDir: join(REPO_ROOT, 'prompts'),
      overridesDir: join(REPO_ROOT, 'no-overrides'),
    }),
    profile: demoProfile(),
    clock: s.clock,
    logger: silentLogger(),
    settings: { ...SETTINGS, ...settings },
  });
  return { s, llm, editorial };
}

function idea(topic: string, overrides: Record<string, unknown> = {}) {
  return {
    topic,
    angle: `A specific point about ${topic}`,
    category: 'technical',
    language: 'en',
    rationale: 'Matches the verified facts.',
    profileSections: ['facts'],
    ...overrides,
  };
}

async function oneIdea({ llm, editorial }: Setup, topic = 'SQLite in production') {
  llm.respond('ideas', { ideas: [idea(topic)] });
  const result = await editorial.generateIdeas(1);
  if (result.kind !== 'ok' || !result.ideas[0]) throw new Error('expected one idea');
  return result.ideas[0];
}

function jobRuns(s: TestServices) {
  return s.handle.sqlite
    .prepare('SELECT job_name, status, error, meta FROM job_runs ORDER BY id')
    .all() as {
    job_name: string;
    status: string;
    error: string | null;
    meta: string | null;
  }[];
}

describe('generateIdeas', () => {
  it('builds the prompt from the profile and settings, and stores the ideas', async () => {
    const setupResult = setup();
    const { llm, editorial, s } = setupResult;
    llm.respond('ideas', {
      ideas: [
        idea('SQLite in production'),
        idea('Code review', { language: 'fr', category: 'opinion' }),
      ],
    });

    const result = await editorial.generateIdeas(2);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.ideas.map((item) => [item.topic, item.language, item.status])).toEqual([
      ['SQLite in production', 'en', 'new'],
      ['Code review', 'fr', 'new'],
    ]);

    const [request] = llm.requestsFor('ideas');
    expect(request?.instructions).toContain('### VERIFIED FACTS');
    expect(request?.instructions).toContain('Jordan Example');
    expect(request?.instructions).toContain(
      'Use exactly one of these categories for each idea: technical, opinion.',
    );
    expect(request?.instructions).toContain('Propose 2 distinct post ideas');
    expect(request?.instructions).not.toContain('{{');
    expect(jobRuns(s)).toEqual([
      expect.objectContaining({ job_name: 'generate-ideas', status: 'succeeded' }),
    ]);
  });

  it('skips ideas in other languages and ideas too close to recent ones', async () => {
    const { llm, editorial } = setup();
    await oneIdea({ llm, editorial } as Setup, 'SQLite in production');
    llm.respond('ideas', {
      ideas: [
        idea('Hablar de bases de datos', { language: 'es' }),
        idea('SQLite in Production'),
        idea('Testing habits'),
        idea('Testing habits'),
      ],
    });
    const result = await editorial.generateIdeas(4);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.ideas.map((item) => item.topic)).toEqual(['Testing habits']);
    expect(result.discarded.map((item) => item.reason)).toEqual([
      'language "es" is not allowed',
      'too close to a recent idea',
      'too close to a recent idea',
    ]);
  });

  it('lists recent topics so the model avoids repeating them', async () => {
    const setupResult = setup();
    await oneIdea(setupResult, 'SQLite in production');
    setupResult.llm.respond('ideas', { ideas: [] });
    await setupResult.editorial.generateIdeas(1);
    expect(setupResult.llm.requestsFor('ideas')[1]?.instructions).toContain(
      '- SQLite in production: A specific point',
    );
  });

  it('reports model failures and records the failed job', async () => {
    const { llm, editorial, s } = setup();
    llm.respond('ideas', new LlmError('auth', 'OpenAI rejected the API key (401).'));
    expect(await editorial.generateIdeas()).toEqual({
      kind: 'error',
      message: 'OpenAI rejected the API key (401).',
    });
    expect(jobRuns(s)[0]).toMatchObject({
      status: 'failed',
      error: 'OpenAI rejected the API key (401).',
    });
  });
});

describe('draftFromIdea', () => {
  it('stores a reviewed draft that is not publishable', async () => {
    const setupResult = setup();
    const { llm, editorial, s } = setupResult;
    const generated = await oneIdea(setupResult);
    llm.respond(
      'drafting',
      draftAnswer('SQLite is a fine default for single-server apps.', {
        claims: [{ claim: 'SQLite is a fine default', basis: 'profile_opinion' }],
      }),
    );
    llm.respond(
      'evaluation',
      keepEvaluation({ issues: ['Could use a concrete example.'], recommendation: 'revise' }),
    );

    const result = await editorial.draftFromIdea(generated.publicId);
    expect(result.kind).toBe('drafted');
    if (result.kind !== 'drafted') return;
    expect(result.post).toMatchObject({ source: 'ai', status: 'draft', version: 1 });
    expect(result.review.evaluation).toEqual({
      scores: { voice: 4, value: 4, clarity: 5 },
      issues: ['Could use a concrete example.'],
      recommendation: 'revise',
    });
    expect(result.review.warnings).toEqual([
      { code: 'editor_note', severity: 'warning', message: 'Could use a concrete example.' },
    ]);

    const version = s.handle.sqlite
      .prepare('SELECT origin, content_hash, checks, generation FROM post_versions')
      .get() as { origin: string; content_hash: string; checks: string; generation: string };
    expect(version.origin).toBe('ai_generated');
    expect(version.content_hash).toBe(
      contentHash('SQLite is a fine default for single-server apps.'),
    );
    expect(JSON.parse(version.checks).claims).toHaveLength(1);
    expect(JSON.parse(version.generation)).toMatchObject({
      attempts: 1,
      models: { drafting: 'fake-drafting' },
    });

    // Never published without an approval, however long we wait.
    s.clock.advance(30 * 24 * 3600_000);
    expect(await s.publisher.publishNextDue()).toBeNull();
    s.handle.sqlite
      .prepare("UPDATE posts SET status = 'scheduled', scheduled_at = 0, slot_key = 'x'")
      .run();
    expect(await s.publisher.publishNextDue()).toMatchObject({
      result: 'blocked',
      reason: 'missing_approval',
    });
    expect(s.x.created).toEqual([]);
  });

  it('revises a draft that fails the checks, telling the model why', async () => {
    const setupResult = setup();
    const { llm, editorial } = setupResult;
    const generated = await oneIdea(setupResult);
    llm.respond(
      'drafting',
      draftAnswer('SQLite is a game-changer for small apps.'),
      draftAnswer('I doubled my revenue with SQLite.', {
        claims: [{ claim: 'doubled my revenue', basis: 'unsupported' }],
      }),
      draftAnswer('SQLite keeps small apps simple: one file, no server to run.'),
    );
    llm.respond('evaluation', keepEvaluation());

    const result = await editorial.draftFromIdea(generated.publicId);
    expect(result.kind).toBe('drafted');
    if (result.kind !== 'drafted') return;
    expect(result.review.attempts).toBe(3);

    const [, second, third] = llm.requestsFor('drafting');
    expect(second?.instructions).toContain('## Revision required');
    expect(second?.instructions).toContain('banned phrase "game-changer"');
    expect(second?.instructions).toContain('SQLite is a game-changer for small apps.');
    expect(third?.instructions).toContain('Unsupported claim');
  });

  it('revises when the editor finds an unsupported claim or rejects the draft', async () => {
    const setupResult = setup();
    const { llm, editorial } = setupResult;
    const generated = await oneIdea(setupResult);
    llm.respond(
      'drafting',
      draftAnswer('First version.'),
      draftAnswer('Second version.'),
      draftAnswer('Third version.'),
    );
    llm.respond(
      'evaluation',
      keepEvaluation({ claims: [{ claim: 'ten years of experience', basis: 'unsupported' }] }),
      keepEvaluation({ recommendation: 'discard', issues: ['Off-voice.'] }),
      keepEvaluation(),
    );
    const result = await editorial.draftFromIdea(generated.publicId);
    expect(result.kind === 'drafted' && result.post.text).toBe('Third version.');
    expect(llm.requestsFor('drafting')[2]?.instructions).toContain(
      'The editor rejected the draft: Off-voice.',
    );
  });

  it('gives up after the allowed regenerations and stores nothing', async () => {
    const setupResult = setup({ maxRegenerations: 1 });
    const { llm, editorial, s } = setupResult;
    const generated = await oneIdea(setupResult);
    llm.respond(
      'drafting',
      draftAnswer('x'.repeat(300)),
      draftAnswer('Bonjour', { language: 'fr' }),
    );

    const result = await editorial.draftFromIdea(generated.publicId);
    expect(result).toMatchObject({
      kind: 'failed',
      reasons: ['The post must be written in "en", not "fr".'],
    });
    expect(s.handle.sqlite.prepare('SELECT COUNT(*) FROM posts').pluck().get()).toBe(0);
    expect(llm.requestsFor('evaluation')).toEqual([]);
  });

  it('rejects a near-duplicate of an existing post', async () => {
    const setupResult = setup();
    const { llm, editorial, s } = setupResult;
    s.queue.submitPersonalPost('Boring technology wins for small teams.');
    const generated = await oneIdea(setupResult);
    llm.respond(
      'drafting',
      draftAnswer('Boring technology wins for small teams!'),
      draftAnswer('A different take on databases.'),
    );
    llm.respond('evaluation', keepEvaluation());
    const result = await editorial.draftFromIdea(generated.publicId);
    expect(result.kind === 'drafted' && result.review.attempts).toBe(2);
  });

  it('keeps the draft with a warning when the review cannot run', async () => {
    const setupResult = setup();
    const { llm, editorial } = setupResult;
    const generated = await oneIdea(setupResult);
    llm.respond('drafting', draftAnswer('A clean post.'));
    llm.respond('evaluation', new LlmError('timeout', 'OpenAI did not answer.'));
    const result = await editorial.draftFromIdea(generated.publicId);
    if (result.kind !== 'drafted') throw new Error('expected a draft');
    expect(result.review.evaluation).toBeNull();
    expect(result.review.warnings.map((warning) => warning.code)).toEqual([
      'evaluation_unavailable',
    ]);
  });

  it('drafts an idea only once', async () => {
    const setupResult = setup();
    const { llm, editorial } = setupResult;
    const generated = await oneIdea(setupResult);
    llm.respond('drafting', draftAnswer('A clean post.'));
    llm.respond('evaluation', keepEvaluation());
    const first = await editorial.draftFromIdea(generated.publicId);
    const second = await editorial.draftFromIdea(generated.publicId);
    expect(second).toEqual({
      kind: 'already_drafted',
      post: first.kind === 'drafted' ? first.post : null,
    });
    expect(await editorial.draftFromIdea('ZZZZZZ')).toEqual({ kind: 'not_found' });
  });
});

describe('regenerateDraft', () => {
  async function drafted(setupResult: Setup) {
    const generated = await oneIdea(setupResult);
    setupResult.llm.respond('drafting', draftAnswer('First draft about SQLite.'));
    setupResult.llm.respond('evaluation', keepEvaluation());
    const result = await setupResult.editorial.draftFromIdea(generated.publicId);
    if (result.kind !== 'drafted') throw new Error('expected a draft');
    return result.post;
  }

  it('creates a new version, back in review, guided by the feedback', async () => {
    const setupResult = setup();
    const { llm, editorial, s } = setupResult;
    const post = await drafted(setupResult);
    llm.respond(
      'drafting',
      draftAnswer('Second take: SQLite removes a whole server from your stack.'),
    );
    llm.respond('evaluation', keepEvaluation());

    const result = await editorial.regenerateDraft(
      post.publicId,
      1,
      'Shorter, with a concrete example',
    );
    expect(result.kind).toBe('regenerated');
    if (result.kind !== 'regenerated') return;
    expect(result.post).toMatchObject({
      version: 2,
      status: 'draft',
      text: 'Second take: SQLite removes a whole server from your stack.',
    });

    const instructions = llm.requestsFor('drafting')[1]?.instructions ?? '';
    expect(instructions).toContain('The author asked for a different version of this post.');
    expect(instructions).toContain("The author's feedback: Shorter, with a concrete example");
    expect(instructions).toContain('First draft about SQLite.');
    expect(
      s.handle.sqlite.prepare('SELECT version, origin FROM post_versions ORDER BY version').all(),
    ).toEqual([
      { version: 1, origin: 'ai_generated' },
      { version: 2, origin: 'ai_regenerated' },
    ]);
  });

  it('voids the approval of the previous version', async () => {
    const setupResult = setup();
    const { llm, editorial, s } = setupResult;
    const post = await drafted(setupResult);
    // Simulate an approved, scheduled version 1.
    s.handle.sqlite
      .prepare(
        `INSERT INTO approvals (post_id, post_version_id, content_hash, decision, telegram_user_id, decided_at)
         SELECT p.id, v.id, v.content_hash, 'approved', 111111, 0 FROM posts p JOIN post_versions v ON v.post_id = p.id`,
      )
      .run();
    s.handle.sqlite
      .prepare("UPDATE posts SET status = 'scheduled', scheduled_at = 0, slot_key = 's'")
      .run();

    llm.respond('drafting', draftAnswer('Another angle on SQLite and backups.'));
    llm.respond('evaluation', keepEvaluation());
    await editorial.regenerateDraft(post.publicId, 1);
    expect(postState(s, post.publicId)).toMatchObject({
      status: 'draft',
      current_version: 2,
      scheduled_at: null,
    });

    s.handle.sqlite
      .prepare("UPDATE posts SET status = 'scheduled', scheduled_at = 0, slot_key = 's'")
      .run();
    expect(await s.publisher.publishNextDue()).toMatchObject({
      result: 'blocked',
      reason: 'missing_approval',
    });
    expect(s.x.created).toEqual([]);
  });

  it('keeps the author’s version if it changed while the model was writing', async () => {
    const setupResult = setup();
    const { llm, editorial, s } = setupResult;
    const post = await drafted(setupResult);
    llm.respond('drafting', () => {
      s.handle.sqlite.prepare('UPDATE posts SET current_version = 2').run();
      s.handle.sqlite
        .prepare(
          `INSERT INTO post_versions (post_id, version, text, content_hash, weighted_length, origin, created_at)
           SELECT post_id, 2, 'Edited by the author', ?, 20, 'user_edited', 0 FROM post_versions`,
        )
        .run(contentHash('Edited by the author'));
      return draftAnswer('Model version');
    });
    llm.respond('evaluation', keepEvaluation());
    const result = await editorial.regenerateDraft(post.publicId, 1);
    expect(result.kind).toBe('outdated');
    expect(s.handle.sqlite.prepare('SELECT COUNT(*) FROM post_versions').pluck().get()).toBe(2);
  });

  it('refuses stale versions and personal posts', async () => {
    const setupResult = setup();
    const post = await drafted(setupResult);
    expect((await setupResult.editorial.regenerateDraft(post.publicId, 2)).kind).toBe('outdated');
    const personal = setupResult.s.queue.submitPersonalPost('Mine');
    if (personal.kind !== 'needs_confirmation') throw new Error('expected a pending post');
    expect((await setupResult.editorial.regenerateDraft(personal.post.publicId, 1)).kind).toBe(
      'not_regenerable',
    );
  });
});
