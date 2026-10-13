/**
 * AI draft review through the bot: real handlers, services and SQLite; the
 * Telegram Bot API and the language model are replaced by recorders.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAiDraft, ideaAnswer } from './helpers/ai.ts';
import { postState } from './helpers/db.ts';
import { draftAnswer, keepEvaluation } from './helpers/fake-llm.ts';
import {
  type ApiCall,
  createTelegramHarness,
  OWNER_ID,
  STRANGER_ID,
  type TelegramHarness,
} from './helpers/telegram.ts';

const harnesses: TelegramHarness[] = [];
function harness(options: Parameters<typeof createTelegramHarness>[0] = {}): TelegramHarness {
  const created = createTelegramHarness(options);
  harnesses.push(created);
  return created;
}
afterEach(() => {
  for (const created of harnesses.splice(0)) {
    if (created.handle.sqlite.open) created.handle.close();
  }
});

function buttons(call: ApiCall | undefined): string[] {
  const markup = call?.payload.reply_markup as
    | { inline_keyboard?: { callback_data?: string }[][] }
    | undefined;
  return markup?.inline_keyboard?.flat().map((button) => button.callback_data ?? '') ?? [];
}

function toasts(bot: TelegramHarness): unknown[] {
  return bot.callsTo('answerCallbackQuery').map((call) => call.payload.text);
}

function approvalUsers(bot: TelegramHarness): unknown[] {
  return bot.handle.sqlite.prepare('SELECT telegram_user_id FROM approvals').pluck().all();
}

describe('review cards', () => {
  it('/drafts shows each waiting draft with buttons bound to its version', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot, 'Boring technology wins.');
    await bot.send('/drafts');
    const card = bot.lastReply();
    expect(String(card.payload.text)).toContain(`AI draft ${draft.publicId}</b> · v1 · en`);
    expect(String(card.payload.text)).toContain('<blockquote>Boring technology wins.</blockquote>');
    expect(String(card.payload.text)).toContain(
      'Nothing is published until you approve this exact text.',
    );
    expect(buttons(card)).toEqual(
      ['a', 'e', 'g', 'j'].map((code) => `${code}:${draft.publicId}:1`),
    );
  });

  it('/drafts says when nothing is waiting', async () => {
    const bot = harness();
    await bot.send('/drafts');
    expect(String(bot.lastReply().payload.text)).toContain('No AI draft is waiting');
  });
});

describe('approve and reject', () => {
  it('approves once, records who approved, and schedules the post', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot);
    await bot.click(`a:${draft.publicId}:1`, 600);
    await bot.click(`a:${draft.publicId}:1`, 600);

    expect(toasts(bot)[0]).toMatch(/^Approved, scheduled for /);
    expect(toasts(bot)[1]).toBe('Already approved');
    expect(String(bot.callsTo('editMessageText')[0]?.payload.text)).toContain(
      `Approved ${draft.publicId} v1`,
    );
    expect(approvalUsers(bot)).toEqual([OWNER_ID]);
    expect(postState(bot, draft.publicId).status).toBe('scheduled');
  });

  it('ignores other users entirely', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot);
    await bot.click(`a:${draft.publicId}:1`, 600, STRANGER_ID);
    await bot.click(`j:${draft.publicId}:1`, 600, STRANGER_ID);
    expect(bot.calls).toEqual([]);
    expect(approvalUsers(bot)).toEqual([]);
    expect(postState(bot, draft.publicId).status).toBe('draft');
  });

  it('rejects, after which the draft cannot be approved', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot);
    await bot.click(`j:${draft.publicId}:1`, 600);
    await bot.click(`a:${draft.publicId}:1`, 600);
    expect(toasts(bot)).toEqual(['Rejected', 'This version was rejected']);
    expect(postState(bot, draft.publicId).status).toBe('rejected');
  });
});

describe('edit', () => {
  it('asks for a reply, stores it verbatim as a new version and voids older buttons', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot, 'Model wording.');
    await bot.click(`e:${draft.publicId}:1`, 600);

    const prompt = bot.lastReply();
    expect(toasts(bot)).toEqual(['Reply to the next message with the new text.']);
    expect(prompt.payload.reply_markup).toMatchObject({ force_reply: true });
    expect(String(prompt.payload.text)).toContain(`Editing ${draft.publicId} v1.`);
    expect(String(prompt.payload.text)).toContain('<pre>Model wording.</pre>');

    const promptText = `✏️ Editing ${draft.publicId} v1. Reply to this message with the complete new text.`;
    await bot.send('My own wording, exactly. ', { replyTo: { text: promptText, fromBot: true } });
    const card = bot.lastReply();
    expect(String(card.payload.text)).toContain(`AI draft ${draft.publicId}</b> · v2`);
    expect(String(card.payload.text)).toContain('Your edited version.');
    expect(buttons(card)[0]).toBe(`a:${draft.publicId}:2`);
    expect(bot.review.card(draft.publicId)?.text).toBe('My own wording, exactly. ');

    await bot.click(`a:${draft.publicId}:1`, 600);
    expect(toasts(bot).at(-1)).toBe('This card is outdated: a newer version exists.');
    await bot.click(`a:${draft.publicId}:2`, 601);
    expect(toasts(bot).at(-1)).toMatch(/^Approved/);
  });

  it('treats a reply to any other message as a new personal post', async () => {
    const bot = harness();
    await bot.send('Just a thought.', { replyTo: { text: 'Some earlier message', fromBot: true } });
    expect(String(bot.lastReply().payload.text)).toContain('New post');
    expect(bot.queue.listQueue(10).total).toBe(1);
  });

  it('refuses an edit prompt that went stale', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot, 'Model wording.');
    bot.review.edit(draft.publicId, 1, 'Edited elsewhere.');
    await bot.send('Late edit', {
      replyTo: { text: `✏️ Editing ${draft.publicId} v1. Reply…`, fromBot: true },
    });
    expect(String(bot.lastReply().payload.text)).toContain('changed since that prompt');
    expect(bot.review.card(draft.publicId)?.text).toBe('Edited elsewhere.');
  });
});

describe('regenerate', () => {
  it('writes a new version in the background and sends its card', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot, 'First draft about SQLite.');
    bot.llm.respond('drafting', draftAnswer('A fresh take on running SQLite in production.'));
    bot.llm.respond('evaluation', keepEvaluation());

    await bot.click(`g:${draft.publicId}:1`, 600);
    expect(toasts(bot)).toEqual(['Writing a new version…']);
    expect(String(bot.callsTo('editMessageText')[0]?.payload.text)).toContain(
      'Writing a new version',
    );
    expect(bot.callsTo('editMessageText')[0]?.payload.reply_markup).toEqual({
      inline_keyboard: [],
    });

    await bot.background.idle();
    const card = bot.lastReply();
    expect(String(card.payload.text)).toContain(`AI draft ${draft.publicId}</b> · v2`);
    expect(String(card.payload.text)).toContain('A fresh take on running SQLite in production.');
    expect(buttons(card)[0]).toBe(`a:${draft.publicId}:2`);
  });

  it('starts only one regeneration at a time', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot);
    let release: () => void = () => {};
    bot.llm.respond(
      'drafting',
      () =>
        new Promise((resolve) => {
          release = () => resolve(draftAnswer('Another angle entirely.'));
        }),
    );
    bot.llm.respond('evaluation', keepEvaluation());

    await bot.click(`g:${draft.publicId}:1`, 600);
    await bot.click(`g:${draft.publicId}:1`, 600);
    expect(toasts(bot)).toEqual(['Writing a new version…', 'Already writing a new version.']);
    release();
    await bot.background.idle();
    expect(bot.llm.requestsFor('drafting')).toHaveLength(2); // the original draft + one regeneration
  });

  it('explains a failure and shows the current version again', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot, 'Original draft text.');
    for (let attempt = 0; attempt < 3; attempt += 1)
      bot.llm.respond('drafting', draftAnswer('x'.repeat(300)));
    await bot.click(`g:${draft.publicId}:1`, 600);
    await bot.background.idle();

    const replies = bot.callsTo('sendMessage').slice(-2);
    expect(String(replies[0]?.payload.text)).toContain('No draft passed the checks');
    expect(String(replies[1]?.payload.text)).toContain('Original draft text.');
    expect(buttons(replies[1])[0]).toBe(`a:${draft.publicId}:1`);
  });
});

describe('ideas', () => {
  it('/ideas proposes ideas in the background, each with a draft button', async () => {
    const bot = harness();
    bot.llm.respond('ideas', {
      ideas: [ideaAnswer('SQLite in production'), ideaAnswer('Code review habits')],
    });
    await bot.send('/ideas 2');
    await bot.background.idle();
    // The acknowledgement always comes before the result.
    const [ack, list] = bot.callsTo('sendMessage');
    expect(String(ack?.payload.text)).toContain('Looking for ideas');
    expect(String(list?.payload.text)).toContain('<b>1. SQLite in production</b>');
    const draftButtons = buttons(list);
    expect(draftButtons).toHaveLength(2);
    expect(draftButtons[0]).toMatch(/^d:[A-Z0-9]{6}$/);

    bot.llm.respond('drafting', draftAnswer('SQLite keeps a small app simple.'));
    bot.llm.respond('evaluation', keepEvaluation());
    await bot.click(draftButtons[0] ?? '', 700);
    expect(toasts(bot)).toEqual(['Writing a draft… it arrives in a moment.']);
    await bot.background.idle();
    expect(String(bot.lastReply().payload.text)).toContain('SQLite keeps a small app simple.');
    expect(buttons(bot.lastReply())).toHaveLength(4);
  });

  it('explains when AI drafting is disabled', async () => {
    const bot = harness({ withoutAi: true });
    await bot.send('/ideas');
    expect(String(bot.lastReply().payload.text)).toContain('AI drafting is disabled');
  });
});

describe('the hard rule, end to end', () => {
  it('publishes an AI post only after approval of its exact current version', async () => {
    const bot = harness();
    const draft = await createAiDraft(bot, 'Version one.');
    const publishAt = async () => {
      const at = postState(bot, draft.publicId).scheduled_at;
      if (at !== null) bot.clock.set(new Date(at));
      return bot.publisher.publishNextDue();
    };

    bot.clock.advance(7 * 24 * 3600_000);
    expect(await bot.publisher.publishNextDue()).toBeNull(); // draft, never approved

    await bot.click(`a:${draft.publicId}:1`, 600);
    bot.review.edit(draft.publicId, 1, 'Version two, edited.');
    expect(await publishAt()).toBeNull(); // edited after approval: back to review

    bot.llm.respond('drafting', draftAnswer('Version three, regenerated.'));
    bot.llm.respond('evaluation', keepEvaluation());
    await bot.click(`g:${draft.publicId}:2`, 601);
    await bot.background.idle();
    await bot.click(`a:${draft.publicId}:2`, 602);
    expect(toasts(bot).at(-1)).toBe('This card is outdated: a newer version exists.');
    expect(await publishAt()).toBeNull();

    await bot.click(`a:${draft.publicId}:3`, 603);
    expect(await publishAt()).toMatchObject({ result: 'published' });
    expect(bot.x.created).toEqual(['Version three, regenerated.']);
  });
});
