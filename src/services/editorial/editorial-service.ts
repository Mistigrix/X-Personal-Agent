/**
 * AI editorial engine: ideas from the author's profile, drafts from ideas,
 * deterministic checks with automatic revision, and an advisory evaluation.
 *
 * Everything produced here is stored as a `draft`. Drafts are never published:
 * publication requires the author's explicit approval of the exact version
 * (enforced by PublicationPolicy, not by this service).
 */
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../db/client.ts';
import {
  findIdeaById,
  findIdeaByPublicId,
  type IdeaRow,
  ideaPublicIdExists,
  insertIdea,
  listRecentIdeas,
  setIdeaStatus,
} from '../../db/repositories/ideas.ts';
import { finishJobRun, startJobRun } from '../../db/repositories/job-runs.ts';
import {
  findByIdeaId,
  findByPublicId,
  insertPostWithFirstVersion,
  insertVersion,
  listRecentTexts,
  publicIdExists,
  updatePost,
} from '../../db/repositories/posts.ts';
import {
  type CheckFinding,
  type Claim,
  checkDraft,
  type DraftCandidate,
  type DraftRules,
  hasErrors,
} from '../../domain/editorial/checks.ts';
import { describeContentMix } from '../../domain/editorial/content-mix.ts';
import { normalizeForSimilarity, similarity } from '../../domain/editorial/similarity.ts';
import { assertTransition, type PostStatus } from '../../domain/post.ts';
import { contentHash, weightedLength } from '../../domain/text.ts';
import {
  addUsage,
  emptyUsage,
  type LlmClient,
  LlmError,
  type LlmUsage,
} from '../../integrations/openai/llm-client.ts';
import type { Clock } from '../../shared/clock.ts';
import { generatePublicId } from '../../shared/ids.ts';
import type { Logger } from '../../shared/logger.ts';
import { type PostView, toPostView } from '../post-view.ts';
import type { PromptTemplates } from './prompts.ts';
import {
  type DraftOutput,
  draftOutputSchema,
  type EvaluationOutput,
  evaluationOutputSchema,
  ideasOutputSchema,
} from './schemas.ts';

export interface EditorialSettings {
  ideasPerRequest: number;
  maxRegenerations: number;
  draftRules: DraftRules;
  contentMix: Readonly<Record<string, number>>;
  topicsFocus: readonly string[];
  defaultLanguage: string;
  languageGuidance: string;
  lookbackPosts: number;
  topicCooldownDays: number;
}

export interface IdeaView {
  publicId: string;
  topic: string;
  angle: string;
  category: string;
  language: string;
  rationale: string | null;
  profileSections: string[];
  status: IdeaRow['status'];
  createdAt: Date;
}

export interface EvaluationSummary {
  scores: { voice: number; value: number; clarity: number };
  issues: string[];
  recommendation: EvaluationOutput['recommendation'];
}

/** What the author sees next to a draft when reviewing it. */
export interface DraftReview {
  warnings: CheckFinding[];
  claims: Claim[];
  evaluation: EvaluationSummary | null;
  attempts: number;
}

export type GenerateIdeasResult =
  | {
      kind: 'ok';
      ideas: IdeaView[];
      discarded: { topic: string; reason: string }[];
      usage: LlmUsage;
    }
  | { kind: 'error'; message: string };

export type DraftResult =
  | { kind: 'drafted'; post: PostView; review: DraftReview; usage: LlmUsage }
  | { kind: 'failed'; reasons: string[]; usage: LlmUsage }
  | { kind: 'already_drafted'; post: PostView | null }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export type RegenerateResult =
  | { kind: 'regenerated'; post: PostView; review: DraftReview; usage: LlmUsage }
  | { kind: 'failed'; reasons: string[]; usage: LlmUsage }
  | { kind: 'not_regenerable'; post: PostView }
  | { kind: 'outdated'; post: PostView }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export interface EditorialService {
  generateIdeas(count?: number): Promise<GenerateIdeasResult>;
  draftFromIdea(ideaPublicId: string): Promise<DraftResult>;
  /** New version of an AI post. Any approval of the previous version no longer applies. */
  regenerateDraft(
    publicId: string,
    expectedVersion: number,
    feedback?: string,
  ): Promise<RegenerateResult>;
}

/** Posts whose text new drafts must not repeat. */
export const RECENT_STATUSES: readonly PostStatus[] = [
  'draft',
  'pending_confirmation',
  'scheduled',
  'publishing',
  'published',
  'uncertain',
];
const REGENERABLE_STATUSES: readonly PostStatus[] = ['draft', 'scheduled'];
const IDEA_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const IMMEDIATE = { behavior: 'immediate' } as const;

type WriteOutcome =
  | {
      kind: 'ok';
      draft: DraftCandidate;
      review: DraftReview;
      generation: Record<string, unknown>;
      usage: LlmUsage;
    }
  | { kind: 'failed'; reasons: string[]; usage: LlmUsage };

export function createEditorialService(deps: {
  db: AppDatabase;
  llm: LlmClient;
  prompts: PromptTemplates;
  /** Labelled profile context (see buildProfileContext). */
  profile: string;
  clock: Clock;
  logger: Logger;
  settings: EditorialSettings;
  /** Aborted on shutdown: cancels model requests in progress. */
  signal?: AbortSignal;
}): EditorialService {
  const { db, llm, prompts, clock, logger, settings } = deps;
  const rules = settings.draftRules;

  /** Records a job run around `work`; any failure becomes an `error` result. */
  async function runJob<T extends { kind: string }>(
    jobName: string,
    work: () => Promise<T>,
    meta: (result: T) => Record<string, unknown>,
  ): Promise<T | { kind: 'error'; message: string }> {
    const jobId = startJobRun(db, { jobName, runKey: `manual:${randomUUID()}`, now: clock.now() });
    try {
      const result = await work();
      finishJobRun(db, jobId, {
        status: 'succeeded',
        now: clock.now(),
        meta: { outcome: result.kind, ...meta(result) },
      });
      return result;
    } catch (error) {
      const message =
        error instanceof LlmError ? error.message : 'Unexpected error while generating content.';
      finishJobRun(db, jobId, { status: 'failed', now: clock.now(), error: message });
      logger.error({ err: error, job: jobName }, 'Editorial job failed');
      return { kind: 'error', message };
    }
  }

  function describeIdea(idea: IdeaRow): string {
    return [
      `Topic: ${idea.topic}`,
      `Angle: ${idea.angle}`,
      `Category: ${idea.category}`,
      ...(idea.rationale ? [`Why it fits the author: ${idea.rationale}`] : []),
      ...(idea.profileRefs?.length
        ? [`Profile sections it relies on: ${idea.profileRefs.join(', ')}`]
        : []),
    ].join('\n');
  }

  function revisionNotes(notes: readonly string[], previousDraft: string | null): string {
    if (notes.length === 0) return '';
    return [
      '',
      '## Revision required',
      'Fix every point below:',
      ...notes.map((note) => `- ${note}`),
      ...(previousDraft
        ? [
            '',
            'Previous draft (write a better one; do not reuse it as is):',
            '"""',
            previousDraft,
            '"""',
          ]
        : []),
    ].join('\n');
  }

  function evaluationFindings(evaluation: EvaluationOutput): CheckFinding[] {
    const findings: CheckFinding[] = evaluation.claims
      .filter((claim) => claim.basis === 'unsupported')
      .map((claim) => ({
        code: 'unsupported_claim',
        severity: 'error' as const,
        message: `The editor found an unsupported claim: "${claim.claim}". Remove it or rephrase without it.`,
      }));
    if (evaluation.recommendation === 'discard') {
      findings.push({
        code: 'editor_discard',
        severity: 'error',
        message: `The editor rejected the draft: ${evaluation.issues.join(' ') || 'no reason given.'}`,
      });
    } else {
      for (const issue of evaluation.issues)
        findings.push({ code: 'editor_note', severity: 'warning', message: issue });
    }
    return findings;
  }

  /** Drafting loop: generate, check, revise on errors, then evaluate (advisory). */
  async function writeDraft(input: {
    idea: string;
    language: string;
    notes: readonly string[];
    previousDraft: string | null;
  }): Promise<WriteOutcome> {
    const recentTexts = listRecentTexts(db, RECENT_STATUSES, settings.lookbackPosts);
    let usage = emptyUsage();
    let notes = [...input.notes];
    let previousDraft = input.previousDraft;
    const maxAttempts = 1 + settings.maxRegenerations;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const postPrompt = prompts.render('generate-post', {
        profile: deps.profile,
        idea: input.idea,
        language: input.language,
        maxWeightedLength: String(rules.text.maxWeightedLength),
        maxHashtags: String(rules.maxHashtags),
        maxEmojis: String(rules.maxEmojis),
        bannedPhrases:
          rules.bannedPhrases.length > 0
            ? rules.bannedPhrases.map((phrase) => `"${phrase}"`).join(', ')
            : 'none',
        revisionNotes: revisionNotes(notes, previousDraft),
      });
      const generated = await llm.generate<DraftOutput>({
        task: 'drafting',
        instructions: postPrompt.text,
        input: 'Write the post now.',
        schema: draftOutputSchema,
        schemaName: 'post_draft',
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      usage = addUsage(usage, generated.usage);

      const draft: DraftCandidate = {
        text: generated.output.text,
        language: generated.output.language.trim().toLowerCase(),
        claims: generated.output.claims,
      };
      const findings = checkDraft(draft, rules, recentTexts);
      if (draft.language !== input.language) {
        findings.push({
          code: 'language_mismatch',
          severity: 'error',
          message: `The post must be written in "${input.language}", not "${draft.language}".`,
        });
      }
      if (hasErrors(findings)) {
        notes = findings
          .filter((finding) => finding.severity === 'error')
          .map((finding) => finding.message);
        previousDraft = draft.text;
        logger.info(
          { attempt, problems: findings.map((finding) => finding.code) },
          'Draft failed checks; revising',
        );
        continue;
      }

      let evaluation: EvaluationSummary | null = null;
      const generation: Record<string, unknown> = {
        models: { drafting: generated.model },
        templates: { post: postPrompt.templateHash },
        attempts: attempt,
      };
      try {
        const evaluationPrompt = prompts.render('evaluate-post', {
          profile: deps.profile,
          language: draft.language,
          draft: draft.text,
        });
        const evaluated = await llm.generate<EvaluationOutput>({
          task: 'evaluation',
          instructions: evaluationPrompt.text,
          input: 'Evaluate the draft now.',
          schema: evaluationOutputSchema,
          schemaName: 'post_evaluation',
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
        usage = addUsage(usage, evaluated.usage);
        generation.models = { drafting: generated.model, evaluation: evaluated.model };
        generation.templates = {
          post: postPrompt.templateHash,
          evaluation: evaluationPrompt.templateHash,
        };

        const editorFindings = evaluationFindings(evaluated.output);
        if (hasErrors(editorFindings)) {
          notes = editorFindings
            .filter((finding) => finding.severity === 'error')
            .map((finding) => finding.message);
          previousDraft = draft.text;
          logger.info(
            { attempt, problems: editorFindings.map((finding) => finding.code) },
            'Draft rejected by the editor; revising',
          );
          continue;
        }
        findings.push(...editorFindings);
        evaluation = {
          scores: {
            voice: evaluated.output.voice,
            value: evaluated.output.value,
            clarity: evaluated.output.clarity,
          },
          issues: evaluated.output.issues,
          recommendation: evaluated.output.recommendation,
        };
      } catch (error) {
        // The evaluation is advisory: without it the draft is still shown, with a warning.
        if (!(error instanceof LlmError)) throw error;
        findings.push({
          code: 'evaluation_unavailable',
          severity: 'warning',
          message: `The automatic review could not run (${error.message}).`,
        });
      }

      return {
        kind: 'ok',
        draft,
        review: { warnings: findings, claims: [...draft.claims], evaluation, attempts: attempt },
        generation: { ...generation, usage },
        usage,
      };
    }
    return { kind: 'failed', reasons: notes, usage };
  }

  function toIdeaView(idea: IdeaRow): IdeaView {
    return {
      publicId: idea.publicId,
      topic: idea.topic,
      angle: idea.angle,
      category: idea.category,
      language: idea.language,
      rationale: idea.rationale,
      profileSections: idea.profileRefs ?? [],
      status: idea.status,
      createdAt: idea.createdAt,
    };
  }

  function reviewChecks(review: DraftReview): Record<string, unknown> {
    return { warnings: review.warnings, claims: review.claims, evaluation: review.evaluation };
  }

  return {
    async generateIdeas(count = settings.ideasPerRequest) {
      return runJob(
        'generate-ideas',
        async (): Promise<GenerateIdeasResult> => {
          const now = clock.now();
          const history = listRecentIdeas(
            db,
            new Date(now.getTime() - IDEA_HISTORY_DAYS * DAY_MS),
            50,
          );
          const prompt = prompts.render('generate-ideas', {
            profile: deps.profile,
            contentMix: describeContentMix(
              settings.contentMix,
              history.filter((idea) => idea.status === 'drafted').map((idea) => idea.category),
            ),
            topicsFocus:
              settings.topicsFocus.length > 0
                ? settings.topicsFocus.join(', ')
                : 'no specific focus',
            topicsAvoid: rules.avoidTopics.length > 0 ? rules.avoidTopics.join(', ') : 'none',
            allowedLanguages: rules.allowedLanguages.join(', '),
            defaultLanguage: settings.defaultLanguage,
            languageGuidance:
              settings.languageGuidance.trim() ||
              'Use the default language unless the subject clearly calls for another allowed language.',
            recentTopics:
              history.length > 0
                ? history
                    .slice(0, 20)
                    .map((idea) => `- ${idea.topic}: ${idea.angle}`)
                    .join('\n')
                : 'None yet.',
            count: String(count),
          });
          const result = await llm.generate({
            task: 'ideas',
            instructions: prompt.text,
            input: `Propose ${count} post ideas now.`,
            schema: ideasOutputSchema,
            schemaName: 'post_ideas',
            ...(deps.signal ? { signal: deps.signal } : {}),
          });

          const cooldownSince = now.getTime() - settings.topicCooldownDays * DAY_MS;
          const comparable = history
            .filter(
              (idea) => idea.status !== 'discarded' && idea.createdAt.getTime() >= cooldownSince,
            )
            .map((idea) => ({ topic: idea.topic, text: `${idea.topic} ${idea.angle}` }));
          const accepted: IdeaRow[] = [];
          const discarded: { topic: string; reason: string }[] = [];

          for (const candidate of result.output.ideas.slice(0, count)) {
            const topic = candidate.topic.trim();
            const language = candidate.language.trim().toLowerCase();
            const text = `${topic} ${candidate.angle}`;
            if (topic === '' || candidate.angle.trim() === '') {
              discarded.push({ topic, reason: 'incomplete idea' });
            } else if (!rules.allowedLanguages.includes(language)) {
              discarded.push({ topic, reason: `language "${language}" is not allowed` });
            } else if (
              comparable.some(
                (other) =>
                  normalizeForSimilarity(other.topic) === normalizeForSimilarity(topic) ||
                  similarity(other.text, text) >= rules.nearDuplicateThreshold,
              )
            ) {
              discarded.push({ topic, reason: 'too close to a recent idea' });
            } else {
              const idea = db.transaction((tx) => {
                let publicId = generatePublicId();
                while (ideaPublicIdExists(tx, publicId)) publicId = generatePublicId();
                return insertIdea(tx, {
                  publicId,
                  topic,
                  angle: candidate.angle.trim(),
                  category: candidate.category.trim().toLowerCase(),
                  language,
                  rationale: candidate.rationale.trim() || null,
                  profileRefs: [...new Set(candidate.profileSections)],
                  fingerprint: normalizeForSimilarity(topic),
                  now: clock.now(),
                });
              }, IMMEDIATE);
              accepted.push(idea);
              comparable.push({ topic, text });
            }
          }
          logger.info(
            { accepted: accepted.length, discarded: discarded.length, usage: result.usage },
            'Ideas generated',
          );
          return { kind: 'ok', ideas: accepted.map(toIdeaView), discarded, usage: result.usage };
        },
        (result) =>
          result.kind === 'ok' ? { ideas: result.ideas.length, usage: result.usage } : {},
      );
    },

    async draftFromIdea(ideaPublicId) {
      const idea = findIdeaByPublicId(db, ideaPublicId);
      if (!idea || idea.status === 'discarded') return { kind: 'not_found' };
      if (idea.status === 'drafted') {
        const existing = findByIdeaId(db, idea.id);
        return { kind: 'already_drafted', post: existing ? toPostView(existing) : null };
      }

      return runJob(
        'draft-from-idea',
        async (): Promise<DraftResult> => {
          const outcome = await writeDraft({
            idea: describeIdea(idea),
            language: idea.language,
            notes: [],
            previousDraft: null,
          });
          if (outcome.kind === 'failed') return outcome;

          const post = db.transaction((tx): PostView | null => {
            const now = clock.now();
            // The idea may have been drafted meanwhile (e.g. a duplicate request).
            if (!setIdeaStatus(tx, idea.id, 'new', 'drafted', now)) return null;
            let publicId = generatePublicId();
            while (publicIdExists(tx, publicId)) publicId = generatePublicId();
            return toPostView(
              insertPostWithFirstVersion(tx, {
                publicId,
                source: 'ai',
                status: 'draft',
                language: outcome.draft.language,
                ideaId: idea.id,
                text: outcome.draft.text,
                contentHash: contentHash(outcome.draft.text),
                weightedLength: weightedLength(outcome.draft.text),
                origin: 'ai_generated',
                checks: reviewChecks(outcome.review),
                generation: outcome.generation,
                now,
              }),
            );
          }, IMMEDIATE);
          if (!post) {
            const existing = findByIdeaId(db, idea.id);
            return { kind: 'already_drafted', post: existing ? toPostView(existing) : null };
          }
          logger.info(
            { postId: post.publicId, ideaId: idea.publicId, usage: outcome.usage },
            'Draft created',
          );
          return { kind: 'drafted', post, review: outcome.review, usage: outcome.usage };
        },
        (result) =>
          result.kind === 'drafted' || result.kind === 'failed'
            ? { usage: result.usage, idea: ideaPublicId }
            : {},
      );
    },

    async regenerateDraft(publicId, expectedVersion, feedback) {
      const record = findByPublicId(db, publicId);
      if (!record) return { kind: 'not_found' };
      if (record.post.source !== 'ai' || !REGENERABLE_STATUSES.includes(record.post.status)) {
        return { kind: 'not_regenerable', post: toPostView(record) };
      }
      if (record.post.currentVersion !== expectedVersion)
        return { kind: 'outdated', post: toPostView(record) };

      const idea = record.post.ideaId !== null ? findIdeaById(db, record.post.ideaId) : undefined;
      return runJob(
        'regenerate-draft',
        async (): Promise<RegenerateResult> => {
          const outcome = await writeDraft({
            idea: idea
              ? describeIdea(idea)
              : `Write a new post on the same subject as this one:\n"""\n${record.version.text}\n"""`,
            language: record.post.language ?? settings.defaultLanguage,
            notes: [
              'The author asked for a different version of this post.',
              ...(feedback?.trim() ? [`The author's feedback: ${feedback.trim()}`] : []),
            ],
            previousDraft: record.version.text,
          });
          if (outcome.kind === 'failed') return outcome;

          return db.transaction((tx): RegenerateResult => {
            const now = clock.now();
            const current = findByPublicId(tx, publicId);
            if (!current) return { kind: 'not_found' };
            const { post } = current;
            // The post changed while the model was writing: keep the author's version.
            if (
              post.currentVersion !== expectedVersion ||
              !REGENERABLE_STATUSES.includes(post.status)
            ) {
              return { kind: 'outdated', post: toPostView(current) };
            }
            const nextVersion = post.currentVersion + 1;
            insertVersion(tx, {
              postId: post.id,
              version: nextVersion,
              text: outcome.draft.text,
              contentHash: contentHash(outcome.draft.text),
              weightedLength: weightedLength(outcome.draft.text),
              origin: 'ai_regenerated',
              checks: reviewChecks(outcome.review),
              generation: outcome.generation,
              now,
            });
            // Back to review: an approval of the previous version does not apply to this one.
            assertTransition(post.source, post.status, 'draft');
            updatePost(tx, post.id, post.status, {
              status: 'draft',
              currentVersion: nextVersion,
              scheduledAt: null,
              slotKey: null,
              updatedAt: now,
            });
            const updated = findByPublicId(tx, publicId);
            if (!updated) throw new Error(`Post ${publicId} disappeared`);
            logger.info(
              { postId: publicId, version: nextVersion, usage: outcome.usage },
              'Draft regenerated',
            );
            return {
              kind: 'regenerated',
              post: toPostView(updated),
              review: outcome.review,
              usage: outcome.usage,
            };
          }, IMMEDIATE);
        },
        (result) =>
          result.kind === 'regenerated' || result.kind === 'failed'
            ? { usage: result.usage, post: publicId }
            : {},
      );
    },
  };
}
