/**
 * End-to-end bot behaviour: real handlers, services and SQLite, with the
 * Telegram Bot API replaced by a recorder (no network).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueService } from '../src/services/queue-service.ts';
import { duePersonalPost, postState } from './helpers/db.ts';
import { createTelegramHarness, STRANGER_ID, type TelegramHarness } from './helpers/telegram.ts';

const harnesses: TelegramHarness[] = [];
const directories: string[] = [];

function harness(options: Parameters<typeof createTelegramHarness>[0] = {}): TelegramHarness {
  const created = createTelegramHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const created of harnesses.splice(0)) {
    if (created.handle.sqlite.open) created.handle.close();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function buttonsOf(call: { payload: Record<string, unknown> }): string[] {
  const markup = call.payload.reply_markup as
    | { inline_keyboard: { callback_data?: string }[][] }
    | undefined;
  return markup?.inline_keyboard.flat().map((button) => button.callback_data ?? '') ?? [];
}

/** Submits a text and returns the preview message, its id and its button payloads. */
async function submit(bot: TelegramHarness, text: string) {
  await bot.send(text);
  const preview = bot.lastReply();
  const [queueButton = '', discardButton = ''] = buttonsOf(preview);
  const messageId = (preview.result as { message_id: number }).message_id;
  return { preview, queueButton, discardButton, messageId };
}

describe('authorization', () => {
  it('ignores messages and button clicks from unknown users, without replying', async () => {
    const bot = harness();
    await bot.send('I want to post this', { userId: STRANGER_ID });
    await bot.send('/queue', { userId: STRANGER_ID });
    await bot.click('q:P7K2QX:1', 1, STRANGER_ID);
    expect(bot.calls).toEqual([]);
    expect(bot.queue.listQueue(10).total).toBe(0);
  });

  it('ignores the owner outside a private chat', async () => {
    const bot = harness();
    await bot.send('posted in a group', { chatType: 'group' });
    expect(bot.calls).toEqual([]);
    expect(bot.queue.listQueue(10).total).toBe(0);
  });
});

describe('submitting a personal post', () => {
  it('shows a preview with the exact text, length and buttons, and stores it', async () => {
    const bot = harness();
    const { preview, queueButton, discardButton, messageId } = await submit(
      bot,
      'Ship <small> things & often 🚀',
    );
    const text = String(preview.payload.text);
    expect(text).toContain('Ship &lt;small&gt; things &amp; often 🚀');
    expect(text).toMatch(/\d+\/280 characters/);
    expect(preview.payload.parse_mode).toBe('HTML');
    expect(queueButton).toMatch(/^q:[A-Z0-9]{6}:1$/);
    expect(discardButton).toMatch(/^x:[A-Z0-9]{6}:1$/);

    const [post] = bot.queue.listQueue(10).posts;
    expect(post).toMatchObject({
      status: 'pending_confirmation',
      text: 'Ship <small> things & often 🚀',
    });
    const card = bot.handle.sqlite.prepare('SELECT card_message_id FROM posts').get() as {
      card_message_id: number;
    };
    expect(card.card_message_id).toBe(messageId);
  });

  it('queues once on [Queue], even when clicked repeatedly', async () => {
    const bot = harness();
    const { queueButton, messageId } = await submit(bot, 'Hello X');
    bot.clearCalls();

    await bot.click(queueButton, messageId);
    expect(bot.callsTo('answerCallbackQuery')[0]?.payload.text).toMatch(/^Queued for /);
    const edit = bot.callsTo('editMessageText')[0];
    expect(String(edit?.payload.text)).toMatch(
      /Queued [A-Z0-9]{6}<\/b> for \w{3} \d+ \w{3}, \d\d:\d\d/,
    );
    expect(edit?.payload.reply_markup).toEqual({ inline_keyboard: [] });

    const scheduledAt = bot.queue.listQueue(10).posts[0]?.scheduledAt;
    await bot.click(queueButton, messageId);
    await bot.click(queueButton, messageId);
    expect(
      bot
        .callsTo('answerCallbackQuery')
        .slice(1)
        .map((call) => call.payload.text),
    ).toEqual(['Already queued', 'Already queued']);
    expect(bot.queue.summary().counts).toEqual({ scheduled: 1 });
    expect(bot.queue.listQueue(10).posts[0]?.scheduledAt).toEqual(scheduledAt);
  });

  it('discards on [Discard], and a later [Queue] cannot revive it', async () => {
    const bot = harness();
    const { queueButton, discardButton, messageId } = await submit(bot, 'Never mind');
    await bot.click(discardButton, messageId);
    expect(bot.queue.listQueue(10).total).toBe(0);
    await bot.click(queueButton, messageId);
    expect(bot.callsTo('answerCallbackQuery').at(-1)?.payload.text).toBe('This post is cancelled.');
    expect(bot.queue.listQueue(10).total).toBe(0);
  });

  it('queues directly without confirmation when configured, warnings excepted', async () => {
    const bot = harness({ confirmPersonalPosts: false });
    await bot.send('Straight to the queue');
    expect(String(bot.lastReply().payload.text)).toContain('Queued');
    expect(buttonsOf(bot.lastReply())).toEqual([]);

    await bot.send('With a link https://example.com');
    expect(String(bot.lastReply().payload.text)).toContain('Contains a link');
    expect(buttonsOf(bot.lastReply())).toHaveLength(2);
  });

  it('rejects an over-length post without saving it', async () => {
    const bot = harness();
    await bot.send('x'.repeat(300));
    expect(String(bot.lastReply().payload.text)).toContain('300/280 characters');
    expect(bot.queue.listQueue(10).total).toBe(0);
  });

  it('answers unknown commands and non-text messages without creating posts', async () => {
    const bot = harness();
    await bot.send('/unknown');
    expect(String(bot.lastReply().payload.text)).toContain('Unknown command');
    await bot.sendUpdate({
      message: {
        message_id: 900,
        date: 1_760_000_000,
        chat: { id: 111111, type: 'private', first_name: 'Owner' },
        from: { id: 111111, is_bot: false, first_name: 'Owner' },
        photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
      },
    });
    expect(String(bot.lastReply().payload.text)).toContain('Only text posts');
    expect(bot.queue.listQueue(10).total).toBe(0);
  });

  it('rejects malformed button payloads gracefully', async () => {
    const bot = harness();
    await bot.click('garbage', 1);
    expect(bot.callsTo('answerCallbackQuery')[0]?.payload.text).toBe(
      'This button is no longer valid.',
    );
  });
});

describe('commands', () => {
  it('/queue lists posts and /cancel removes one', async () => {
    const bot = harness();
    const { queueButton, messageId } = await submit(bot, 'First post');
    await bot.click(queueButton, messageId);
    const publicId = queueButton.split(':')[1] ?? '';

    await bot.send('/queue');
    expect(String(bot.lastReply().payload.text)).toContain(`<code>${publicId}</code>`);

    await bot.send(`/cancel ${publicId.toLowerCase()}`);
    expect(String(bot.lastReply().payload.text)).toContain(`Cancelled ${publicId}`);
    await bot.send('/queue');
    expect(String(bot.lastReply().payload.text)).toContain('The queue is empty');

    await bot.send('/cancel');
    expect(String(bot.lastReply().payload.text)).toContain('Usage');
  });

  it('/pause, /status and /resume control and report the publication state', async () => {
    const bot = harness();
    await bot.send('/pause');
    expect(String(bot.lastReply().payload.text)).toContain('paused');
    expect(bot.scheduler.isPaused()).toBe(true);
    await bot.send('/status');
    expect(String(bot.lastReply().payload.text)).toContain('Publication: <b>paused</b>');
    expect(String(bot.lastReply().payload.text)).toContain('dry run');
    await bot.send('/resume');
    expect(bot.scheduler.isPaused()).toBe(false);
  });

  it('/start explains the bot and the current mode', async () => {
    const bot = harness();
    await bot.send('/start');
    const text = String(bot.lastReply().payload.text);
    expect(text).toContain('exactly as written');
    expect(text).toContain('dry run');
  });
});

describe('reliability', () => {
  it('keeps queued posts across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'x-agent-bot-'));
    directories.push(directory);
    const databasePath = join(directory, 'agent.db');

    const first = harness({ databasePath });
    const { queueButton, messageId } = await submit(first, 'Survives a restart');
    await first.click(queueButton, messageId);
    first.handle.close();

    const second = harness({ databasePath });
    await second.send('/queue');
    expect(String(second.lastReply().payload.text)).toContain('“Survives a restart”');
  });

  it('tells the user when handling fails, without publishing anything', async () => {
    const failingQueue = new Proxy({} as QueueService, {
      get: () => () => {
        throw new Error('database unavailable');
      },
    });
    const bot = harness({ queue: failingQueue });
    await bot.send('Hello');
    expect(String(bot.lastReply().payload.text)).toContain('Something went wrong');
  });
});

describe('publication decisions from alerts', () => {
  async function failedPost(bot: TelegramHarness, outcome: 'failed' | 'uncertain') {
    const post = duePersonalPost(bot, 'Needs a decision');
    bot.x.script(
      outcome === 'failed'
        ? { kind: 'rejected', retryable: false, code: 'http_400', message: 'Invalid.' }
        : { kind: 'unknown', code: 'timeout', message: 'No answer.' },
    );
    await bot.publisher.publishNextDue();
    return post.publicId;
  }

  it('[Publish again] reschedules a failed post, once', async () => {
    const bot = harness();
    const publicId = await failedPost(bot, 'failed');
    await bot.click(`r:${publicId}:1`, 42);
    expect(bot.callsTo('answerCallbackQuery')[0]?.payload.text).toMatch(/^Rescheduled for /);
    expect(postState(bot, publicId).status).toBe('scheduled');
    await bot.click(`r:${publicId}:1`, 42);
    expect(bot.callsTo('answerCallbackQuery')[1]?.payload.text).toBe('This post is scheduled.');
  });

  it('[It is on X] resolves an uncertain post without sending it again', async () => {
    const bot = harness();
    const publicId = await failedPost(bot, 'uncertain');
    await bot.click(`m:${publicId}:1`, 42);
    expect(bot.callsTo('answerCallbackQuery')[0]?.payload.text).toBe('Marked as published');
    expect(postState(bot, publicId).status).toBe('published');
    expect(bot.x.created).toHaveLength(1);
  });

  it('[Cancel] drops a failed post', async () => {
    const bot = harness();
    const publicId = await failedPost(bot, 'failed');
    await bot.click(`c:${publicId}:1`, 42);
    expect(bot.callsTo('answerCallbackQuery')[0]?.payload.text).toBe('Cancelled');
    expect(postState(bot, publicId).status).toBe('cancelled');
  });

  it('refuses outdated cards and other users', async () => {
    const bot = harness();
    const publicId = await failedPost(bot, 'failed');
    await bot.click(`r:${publicId}:2`, 42);
    expect(bot.callsTo('answerCallbackQuery')[0]?.payload.text).toBe('This card is outdated.');
    await bot.click(`r:${publicId}:1`, 42, STRANGER_ID);
    expect(postState(bot, publicId).status).toBe('failed');
  });
});
