/**
 * Telegram bot: translates updates into service calls and renders the results.
 * Business rules live in the services; this layer only parses and presents.
 */
import { Bot, type Context, GrammyError } from 'grammy';
import type { Message, UserFromGetMe } from 'grammy/types';
import type { QueueService } from '../../services/queue-service.ts';
import type { SchedulerService } from '../../services/scheduler-service.ts';
import { parsePublicId } from '../../shared/ids.ts';
import type { Logger } from '../../shared/logger.ts';
import { authorize } from './auth.ts';
import { decodeCallback } from './callbacks.ts';
import {
  addHelpView,
  cancelResultView,
  cancelUsageView,
  confirmOutcome,
  discardOutcome,
  editedMessageView,
  errorView,
  helpView,
  invalidPostView,
  pauseView,
  previewView,
  queuedView,
  queueFullView,
  queueView,
  resumeView,
  statusView,
  unknownCommandView,
  unsupportedMessageView,
  type View,
  type ViewContext,
  welcomeView,
} from './views.ts';

export interface BotDependencies {
  token: string;
  allowedUserIds: readonly number[];
  queue: QueueService;
  scheduler: SchedulerService;
  view: ViewContext;
  logger: Logger;
  /** Skips the getMe call (tests). */
  botInfo?: UserFromGetMe;
}

/** Commands shown in Telegram's command menu. */
export const BOT_COMMANDS = [
  { command: 'queue', description: 'List queued posts' },
  { command: 'status', description: 'Mode, pause state and next publication' },
  { command: 'cancel', description: 'Cancel a queued post: /cancel ID' },
  { command: 'pause', description: 'Pause automatic publication' },
  { command: 'resume', description: 'Resume automatic publication' },
  { command: 'add', description: 'How to submit a post' },
  { command: 'help', description: 'List commands' },
];

/** Updates the bot subscribes to. */
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query'] as const;

const QUEUE_PAGE_SIZE = 20;

export function createBot(deps: BotDependencies): Bot {
  const { queue, scheduler, view: context, logger } = deps;
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});

  bot.use(authorize(deps.allowedUserIds, logger));

  bot.command('start', (ctx) => reply(ctx, welcomeView(context)));
  bot.command('help', (ctx) => reply(ctx, helpView()));
  bot.command('add', (ctx) => reply(ctx, addHelpView(context)));
  bot.command('queue', (ctx) =>
    reply(ctx, queueView(queue.listQueue(QUEUE_PAGE_SIZE), context, scheduler.isPaused())),
  );
  bot.command('status', (ctx) =>
    reply(ctx, statusView(queue.summary(), context, scheduler.isPaused())),
  );
  bot.command('pause', (ctx) => {
    const changed = scheduler.pause();
    logger.info({ changed }, 'Publication paused by user');
    return reply(ctx, pauseView(changed));
  });
  bot.command('resume', (ctx) => {
    const changed = scheduler.resume();
    logger.info({ changed }, 'Publication resumed by user');
    return reply(ctx, resumeView(changed));
  });
  bot.command('cancel', (ctx) => {
    const publicId = parsePublicId(ctx.match);
    if (!publicId) return reply(ctx, cancelUsageView());
    const result = queue.cancel(publicId);
    logger.info({ postId: publicId, outcome: result.kind }, 'Cancel requested');
    return reply(ctx, cancelResultView(result));
  });

  bot.on('message:text', async (ctx) => {
    if (startsWithCommand(ctx.message)) return reply(ctx, unknownCommandView());

    const result = queue.submitPersonalPost(ctx.message.text);
    logger.info(
      { outcome: result.kind, postId: 'post' in result ? result.post.publicId : undefined },
      'Personal post received',
    );
    switch (result.kind) {
      case 'invalid':
        return reply(ctx, invalidPostView(result.analysis));
      case 'queue_full':
        return reply(ctx, queueFullView());
      case 'needs_confirmation': {
        const sent = await reply(
          ctx,
          previewView(result.post, result.analysis, result.projectedSlot, context),
        );
        queue.attachCard(result.post.publicId, {
          chatId: sent.chat.id,
          messageId: sent.message_id,
        });
        return sent;
      }
      case 'scheduled': {
        const sent = await reply(ctx, queuedView(result.post, context, scheduler.isPaused()));
        queue.attachCard(result.post.publicId, {
          chatId: sent.chat.id,
          messageId: sent.message_id,
        });
        return sent;
      }
    }
  });

  bot.on('message', (ctx) => reply(ctx, unsupportedMessageView()));
  bot.on('edited_message', (ctx) => reply(ctx, editedMessageView()));

  bot.on('callback_query:data', async (ctx) => {
    const payload = decodeCallback(ctx.callbackQuery.data);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: 'This button is no longer valid.' });
      return;
    }

    const outcome =
      payload.action === 'queue'
        ? confirmOutcome(
            queue.confirm(payload.publicId, payload.version),
            context,
            scheduler.isPaused(),
          )
        : discardOutcome(queue.cancel(payload.publicId, payload.version));
    logger.info({ postId: payload.publicId, action: payload.action }, 'Card button handled');

    await ctx.answerCallbackQuery({ text: outcome.toast });
    if (outcome.card) await editCard(ctx, outcome.card);
  });
  bot.on('callback_query', (ctx) => ctx.answerCallbackQuery());

  bot.catch(async (error) => {
    logger.error(
      { err: error.error, updateId: error.ctx.update.update_id },
      'Failed to handle a Telegram update',
    );
    try {
      if (error.ctx.chat) await reply(error.ctx, errorView());
    } catch {
      // The failure is already logged; nothing else to do.
    }
  });

  return bot;
}

function reply(ctx: Context, view: View) {
  return ctx.reply(view.text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(view.keyboard ? { reply_markup: view.keyboard } : {}),
  });
}

/** Replaces a card's content and removes its buttons. */
async function editCard(ctx: Context, view: View): Promise<void> {
  try {
    await ctx.editMessageText(view.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: view.keyboard ?? { inline_keyboard: [] },
    });
  } catch (error) {
    // A repeated click renders the same card again; Telegram rejects that as "not modified".
    if (error instanceof GrammyError && error.description.includes('message is not modified'))
      return;
    throw error;
  }
}

function startsWithCommand(message: Message): boolean {
  return (
    message.entities?.some((entity) => entity.type === 'bot_command' && entity.offset === 0) ??
    false
  );
}
