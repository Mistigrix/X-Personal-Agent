/**
 * Telegram bot: translates updates into service calls and renders the results.
 * Business rules live in the services; this layer only parses and presents.
 * Slow work (model calls) runs in the background so the bot stays responsive.
 */
import { type Api, Bot, type Context, GrammyError } from 'grammy';
import type { Message, UserFromGetMe } from 'grammy/types';
import type { EditorialService } from '../../services/editorial/editorial-service.ts';
import type { PublisherService } from '../../services/publisher-service.ts';
import type { QueueService } from '../../services/queue-service.ts';
import type { ReviewService } from '../../services/review-service.ts';
import type { SchedulerService } from '../../services/scheduler-service.ts';
import type { BackgroundTasks } from '../../shared/background.ts';
import { parsePublicId } from '../../shared/ids.ts';
import type { Logger } from '../../shared/logger.ts';
import { authorize } from './auth.ts';
import { decodeCallback, type PostAction } from './callbacks.ts';
import {
  addHelpView,
  aiDisabledView,
  approveOutcome,
  cancelOutcome,
  cancelResultView,
  cancelUsageView,
  confirmOutcome,
  discardOutcome,
  editedMessageView,
  editPromptView,
  editResultView,
  errorView,
  generationFailedView,
  helpView,
  ideasView,
  invalidPostView,
  markPublishedOutcome,
  noDraftsView,
  parseEditPrompt,
  pauseView,
  previewView,
  queuedView,
  queueFullView,
  queueView,
  regeneratingView,
  rejectOutcome,
  resumeView,
  retryOutcome,
  reviewCardView,
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
  publisher: Pick<PublisherService, 'retry' | 'markPublished'>;
  review: ReviewService;
  /** Null when AI drafting is disabled. */
  editorial: EditorialService | null;
  background: BackgroundTasks;
  view: ViewContext;
  logger: Logger;
  /** Skips the getMe call (tests). */
  botInfo?: UserFromGetMe;
}

/** Commands shown in Telegram's command menu. */
export const BOT_COMMANDS = [
  { command: 'ideas', description: 'Propose AI post ideas' },
  { command: 'drafts', description: 'AI drafts waiting for your review' },
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
const DRAFT_CARDS_PER_REQUEST = 5;

type Outcome = { toast: string; card: View | null };

export function createBot(deps: BotDependencies): Bot {
  const {
    queue,
    scheduler,
    publisher,
    review,
    editorial,
    background,
    view: context,
    logger,
  } = deps;
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});

  /** Sends an AI draft's review card and remembers which message shows it. */
  async function sendReviewCard(api: Api, chatId: number, publicId: string): Promise<void> {
    const card = review.card(publicId);
    if (!card) return;
    const sent = await send(api, chatId, reviewCardView(card, context));
    queue.attachCard(publicId, { chatId: sent.chat.id, messageId: sent.message_id });
  }

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

  bot.command('ideas', async (ctx) => {
    if (!editorial) return reply(ctx, aiDisabledView());
    if (background.isRunning('ideas')) return reply(ctx, { text: 'Already looking for ideas…' });
    const requested = Number.parseInt(ctx.match, 10);
    const count =
      Number.isInteger(requested) && requested >= 1 && requested <= 10 ? requested : undefined;
    const chatId = ctx.chat.id;
    // Acknowledge first, so the answer can never arrive before it.
    const sent = await reply(ctx, { text: '💡 Looking for ideas… (this can take a minute)' });
    background.run('ideas', async () => {
      const result = await editorial.generateIdeas(count);
      await send(
        ctx.api,
        chatId,
        result.kind === 'ok' ? ideasView(result) : { text: `⚠️ ${result.message}` },
      );
    });
    return sent;
  });

  bot.command('drafts', async (ctx) => {
    const drafts = review.pendingDrafts(DRAFT_CARDS_PER_REQUEST + 1);
    if (drafts.length === 0) return reply(ctx, noDraftsView());
    for (const card of drafts.slice(0, DRAFT_CARDS_PER_REQUEST)) {
      await sendReviewCard(ctx.api, ctx.chat.id, card.publicId);
    }
    if (drafts.length > DRAFT_CARDS_PER_REQUEST) {
      return reply(ctx, {
        text: 'More drafts are waiting: decide on these first, then use /drafts again.',
      });
    }
    return undefined;
  });

  bot.on('message:text', async (ctx) => {
    if (startsWithCommand(ctx.message)) return reply(ctx, unknownCommandView());

    // A reply to an edit prompt is the new text of an AI draft, not a new post.
    const replied = ctx.message.reply_to_message;
    const target = replied?.from?.id === ctx.me.id ? parseEditPrompt(replied.text ?? '') : null;
    if (target) {
      const result = review.edit(target.publicId, target.version, ctx.message.text);
      logger.info({ postId: target.publicId, outcome: result.kind }, 'Draft edited by user');
      const sent = await reply(ctx, editResultView(result, context));
      if (result.kind === 'edited') {
        queue.attachCard(target.publicId, { chatId: sent.chat.id, messageId: sent.message_id });
      }
      return sent;
    }

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
    const chatId = ctx.chat?.id;
    if (!payload || chatId === undefined) {
      await ctx.answerCallbackQuery({ text: 'This button is no longer valid.' });
      return;
    }

    if (payload.action === 'draftIdea') {
      if (!editorial) {
        await ctx.answerCallbackQuery({ text: 'AI drafting is disabled.' });
        return;
      }
      const { ideaId } = payload;
      const key = `draft:${ideaId}`;
      if (background.isRunning(key)) {
        await ctx.answerCallbackQuery({ text: 'Already writing this draft.' });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Writing a draft… it arrives in a moment.' });
      logger.info({ ideaId }, 'Draft requested');
      background.run(key, async () => {
        const result = await editorial.draftFromIdea(ideaId);
        switch (result.kind) {
          case 'drafted':
            return sendReviewCard(ctx.api, chatId, result.post.publicId);
          case 'already_drafted':
            if (result.post) return sendReviewCard(ctx.api, chatId, result.post.publicId);
            return void (await send(ctx.api, chatId, { text: 'This idea was already drafted.' }));
          case 'failed':
            return void (await send(ctx.api, chatId, generationFailedView(result.reasons)));
          case 'not_found':
            return void (await send(ctx.api, chatId, { text: 'This idea no longer exists.' }));
          case 'error':
            return void (await send(ctx.api, chatId, { text: `⚠️ ${result.message}` }));
        }
      });
      return;
    }

    const { action, publicId, version } = payload;
    logger.info({ postId: publicId, action }, 'Card button pressed');

    if (action === 'edit') {
      const card = review.card(publicId);
      if (!card || card.version !== version) {
        await ctx.answerCallbackQuery({ text: 'This card is outdated: a newer version exists.' });
        return;
      }
      if (card.status !== 'draft' && card.status !== 'scheduled') {
        await ctx.answerCallbackQuery({ text: 'This post can no longer be edited.' });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Reply to the next message with the new text.' });
      await reply(ctx, editPromptView(card));
      return;
    }

    if (action === 'regenerate') {
      await regenerate(ctx, chatId, publicId, version);
      return;
    }

    const outcome = decide(action, publicId, version, ctx.from.id);
    await ctx.answerCallbackQuery({ text: outcome.toast });
    if (outcome.card) await editCard(ctx, outcome.card);
  });
  bot.on('callback_query', (ctx) => ctx.answerCallbackQuery());

  /** Decisions that complete immediately. */
  function decide(
    action: Exclude<PostAction, 'edit' | 'regenerate'>,
    publicId: string,
    version: number,
    userId: number,
  ): Outcome {
    switch (action) {
      case 'queue':
        return confirmOutcome(queue.confirm(publicId, version), context, scheduler.isPaused());
      case 'discard':
        return discardOutcome(queue.cancel(publicId, version));
      case 'retry':
        return retryOutcome(publisher.retry(publicId, version), context);
      case 'markPublished':
        return markPublishedOutcome(publisher.markPublished(publicId, version));
      case 'cancel':
        return cancelOutcome(queue.cancel(publicId, version));
      case 'approve': {
        const result = review.approve(publicId, version, userId);
        logger.info({ postId: publicId, version, outcome: result.kind }, 'AI draft approval');
        return approveOutcome(result, context);
      }
      case 'reject': {
        const result = review.reject(publicId, version, userId);
        logger.info({ postId: publicId, version, outcome: result.kind }, 'AI draft rejection');
        return rejectOutcome(result);
      }
    }
  }

  async function regenerate(ctx: Context, chatId: number, publicId: string, version: number) {
    const card = review.card(publicId);
    if (!editorial) {
      await ctx.answerCallbackQuery({ text: 'AI drafting is disabled.' });
      return;
    }
    if (!card || card.version !== version) {
      await ctx.answerCallbackQuery({ text: 'This card is outdated: a newer version exists.' });
      return;
    }
    const key = `regenerate:${publicId}`;
    if (background.isRunning(key)) {
      await ctx.answerCallbackQuery({ text: 'Already writing a new version.' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Writing a new version…' });
    // The old card loses its buttons: decisions apply to the version that comes next.
    await editCard(ctx, regeneratingView(card));
    background.run(key, async () => {
      const result = await editorial.regenerateDraft(publicId, version);
      switch (result.kind) {
        case 'regenerated':
          return sendReviewCard(ctx.api, chatId, publicId);
        case 'failed':
          await send(ctx.api, chatId, generationFailedView(result.reasons));
          return sendReviewCard(ctx.api, chatId, publicId);
        case 'error':
          await send(ctx.api, chatId, { text: `⚠️ ${result.message}` });
          return sendReviewCard(ctx.api, chatId, publicId);
        case 'outdated':
        case 'not_regenerable':
          await send(ctx.api, chatId, {
            text: `${publicId} changed meanwhile: here is its current version.`,
          });
          return sendReviewCard(ctx.api, chatId, publicId);
        case 'not_found':
          return void (await send(ctx.api, chatId, { text: 'This post no longer exists.' }));
      }
    });
  }

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

function messageOptions(view: View) {
  const markup = view.keyboard
    ? { reply_markup: view.keyboard }
    : view.forceReply
      ? {
          reply_markup: {
            force_reply: true as const,
            input_field_placeholder: view.forceReply.placeholder,
          },
        }
      : {};
  return { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, ...markup };
}

function reply(ctx: Context, view: View) {
  return ctx.reply(view.text, messageOptions(view));
}

function send(api: Api, chatId: number, view: View) {
  return api.sendMessage(chatId, view.text, messageOptions(view));
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
    if (error instanceof GrammyError && error.description.includes('message is not modified')) {
      return;
    }
    throw error;
  }
}

function startsWithCommand(message: Message): boolean {
  return (
    message.entities?.some((entity) => entity.type === 'bot_command' && entity.offset === 0) ??
    false
  );
}
