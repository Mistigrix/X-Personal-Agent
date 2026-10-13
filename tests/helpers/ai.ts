import type { PostView } from '../../src/services/post-view.ts';
import { draftAnswer, keepEvaluation } from './fake-llm.ts';
import type { TestServices } from './services.ts';

/** Distinct enough not to be filtered as near-duplicate ideas. */
const TOPICS = [
  'SQLite in production',
  'Code review habits',
  'Deploying on a small VPS',
  'Learning by shipping',
  'Saying no to features',
  'Writing useful tests',
  'Pricing a freelance project',
  'Monthly junior workshop',
];
let ideaCounter = 0;

export function ideaAnswer(topic: string, overrides: Record<string, unknown> = {}) {
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

/** Creates an AI draft through the real editorial service, with scripted model answers. */
export async function createAiDraft(
  services: TestServices,
  text = 'SQLite keeps small apps simple.',
): Promise<PostView> {
  const topic = TOPICS[ideaCounter % TOPICS.length] ?? 'Fallback topic';
  ideaCounter += 1;
  services.llm.respond('ideas', { ideas: [ideaAnswer(topic)] });
  const ideas = await services.editorial.generateIdeas(1);
  if (ideas.kind !== 'ok' || !ideas.ideas[0]) throw new Error('expected an idea');
  services.llm.respond('drafting', draftAnswer(text));
  services.llm.respond('evaluation', keepEvaluation());
  const result = await services.editorial.draftFromIdea(ideas.ideas[0].publicId);
  if (result.kind !== 'drafted') throw new Error(`expected a draft, got ${result.kind}`);
  return result.post;
}
