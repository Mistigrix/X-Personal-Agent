import { afterEach, describe, expect, it } from 'vitest';
import { createAiDraft, ideaAnswer } from '../../tests/helpers/ai.ts';
import { draftAnswer, keepEvaluation } from '../../tests/helpers/fake-llm.ts';
import {
  createTestServices,
  silentLogger,
  type TestServices,
} from '../../tests/helpers/services.ts';
import { LlmError } from '../integrations/openai/llm-client.ts';
import { createDailyDrafts } from './daily-drafts.ts';

const opened: TestServices[] = [];
afterEach(() => {
  for (const created of opened.splice(0)) created.handle.close();
});

/** Monday 12 October 2026, Africa/Abidjan (UTC+0). */
const at = (time: string, day = 12) => new Date(`2026-10-${day}T${time}:00Z`);

function setup(maxPendingDrafts = 2) {
  const s = createTestServices();
  opened.push(s);
  const daily = createDailyDrafts({
    db: s.db,
    editorial: s.editorial,
    review: s.review,
    scheduler: s.scheduler,
    notifier: s.notifier,
    clock: s.clock,
    logger: silentLogger(),
    settings: { timezone: 'Africa/Abidjan', at: '07:00', maxPendingDrafts, lookaheadDays: 2 },
  });
  return { s, daily };
}

function scriptDrafts(s: TestServices, topics: string[]) {
  s.llm.respond('ideas', { ideas: topics.map((topic) => ideaAnswer(topic)) });
  for (const topic of topics) {
    s.llm.respond(
      'drafting',
      draftAnswer(`A post about ${topic.toLowerCase()} and why it matters.`),
    );
    s.llm.respond('evaluation', keepEvaluation());
  }
}

describe('daily drafts', () => {
  it('waits for the configured local time', async () => {
    const { s, daily } = setup();
    s.clock.set(at('06:59'));
    expect(await daily.runIfDue()).toEqual({ kind: 'skipped', reason: 'not_due' });
    expect(s.llm.requests).toEqual([]);
  });

  it('prepares drafts once per day and sends them for review', async () => {
    const { s, daily } = setup(2);
    s.clock.set(at('07:00'));
    scriptDrafts(s, ['SQLite in production', 'Code review habits']);

    expect(await daily.runIfDue()).toEqual({ kind: 'done', created: 2 });
    expect(s.notifier.events.map((event) => event.type)).toEqual(['draft_ready', 'draft_ready']);
    expect(s.review.pendingDrafts(10)).toHaveLength(2);

    s.clock.set(at('15:00'));
    expect(await daily.runIfDue()).toEqual({ kind: 'skipped', reason: 'already_ran' });
  });

  it('never exceeds the number of pending drafts allowed', async () => {
    const { s, daily } = setup(2);
    await createAiDraft(s, 'One pending draft already.');
    s.clock.set(at('08:00'));
    scriptDrafts(s, ['Deploying on a small VPS']);
    expect(await daily.runIfDue()).toEqual({ kind: 'done', created: 1 });
    expect(s.llm.requestsFor('ideas').at(-1)?.input).toBe('Propose 1 post ideas now.');

    // Before the first window opens, so all 6 slots of the next two days are upcoming.
    s.clock.set(at('07:59', 13));
    expect(await daily.runIfDue()).toEqual({ kind: 'nothing_needed', pending: 2, freeSlots: 6 });
  });

  it('never prepares more drafts than there are free slots', async () => {
    const { s, daily } = setup(5);
    // Fill all but one of the slots in the next two days with personal posts.
    const slots = s.scheduler.upcoming(2).length;
    for (let index = 0; index < slots - 1; index += 1) {
      const submitted = s.queue.submitPersonalPost(
        `Personal post number ${index} with its own words ${'!'.repeat(index)}`,
      );
      if (submitted.kind === 'needs_confirmation') s.queue.confirm(submitted.post.publicId, 1);
    }
    s.clock.set(at('07:30'));
    scriptDrafts(s, ['Learning by shipping']);
    expect(await daily.runIfDue()).toEqual({ kind: 'done', created: 1 });
  });

  it('reports a generation failure once and does not retry the same day', async () => {
    const { s, daily } = setup();
    s.clock.set(at('07:00'));
    s.llm.respond('ideas', new LlmError('rate_limited', 'OpenAI quota reached.'));
    expect(await daily.runIfDue()).toEqual({ kind: 'failed', message: 'OpenAI quota reached.' });
    expect(s.notifier.events).toEqual([
      { type: 'editorial_error', message: 'Daily drafts: OpenAI quota reached.' },
    ]);
    expect(await daily.runIfDue()).toEqual({ kind: 'skipped', reason: 'already_ran' });
  });
});
