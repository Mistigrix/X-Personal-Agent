/**
 * Drives the real bot with fabricated updates and records every Bot API call
 * instead of sending it. No network access.
 */
import { type Bot, BotError, type Transformer } from 'grammy';
import type { MessageEntity, Update, UserFromGetMe } from 'grammy/types';
import { createBot } from '../../src/integrations/telegram/bot.ts';
import type { ViewContext } from '../../src/integrations/telegram/views.ts';
import type { QueueService } from '../../src/services/queue-service.ts';
import { fakeTelegramToken } from './fixtures.ts';
import { createTestServices, silentLogger, type TestServices } from './services.ts';

export const OWNER_ID = 111111;
export const STRANGER_ID = 999999;

const BOT_INFO = {
  id: 424242,
  is_bot: true,
  first_name: 'Test Agent',
  username: 'test_agent_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

export const TEST_VIEW: ViewContext = {
  timezone: 'Africa/Abidjan',
  maxWeightedLength: 280,
  publishMode: 'dry-run',
  publishingAvailable: true,
};

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
  /** The fake result returned to the bot (e.g. the sent message). */
  result: unknown;
}

export interface TelegramHarness extends TestServices {
  bot: Bot;
  calls: ApiCall[];
  /** Sends a text message (commands get their bot_command entity automatically). */
  send(
    text: string,
    from?: {
      userId?: number;
      chatType?: 'private' | 'group';
      replyTo?: { text: string; fromBot: boolean };
    },
  ): Promise<void>;
  sendUpdate(update: Omit<Update, 'update_id'>): Promise<void>;
  click(data: string, messageId: number, userId?: number): Promise<void>;
  callsTo(method: string): ApiCall[];
  lastReply(): ApiCall;
  clearCalls(): void;
}

export function createTelegramHarness(
  options: Parameters<typeof createTestServices>[0] & {
    queue?: QueueService;
    withoutAi?: boolean;
  } = {},
): TelegramHarness {
  const services = createTestServices(options);
  const logger = silentLogger();
  const bot = createBot({
    token: fakeTelegramToken(),
    allowedUserIds: [OWNER_ID],
    queue: options.queue ?? services.queue,
    scheduler: services.scheduler,
    publisher: services.publisher,
    review: services.review,
    editorial: options.withoutAi ? null : services.editorial,
    background: services.background,
    view: TEST_VIEW,
    logger,
    botInfo: BOT_INFO,
  });

  const calls: ApiCall[] = [];
  let nextMessageId = 500;
  let nextUpdateId = 1;

  const recorder: Transformer = async (_previous, method, payload) => {
    const body = payload as Record<string, unknown>;
    const result =
      method === 'sendMessage'
        ? {
            message_id: ++nextMessageId,
            date: 1_760_000_000,
            chat: { id: body.chat_id, type: 'private', first_name: 'Owner' },
            text: body.text,
          }
        : true;
    calls.push({ method, payload: body, result });
    return { ok: true, result } as never;
  };
  bot.api.config.use(recorder);

  const user = (id: number) => ({
    id,
    is_bot: false,
    first_name: id === OWNER_ID ? 'Owner' : 'Stranger',
  });

  /** Handles an update the way long polling does: errors go to the bot's error handler. */
  async function sendUpdate(update: Omit<Update, 'update_id'>) {
    try {
      await bot.handleUpdate({ update_id: nextUpdateId++, ...update } as Update);
    } catch (error) {
      if (!(error instanceof BotError)) throw error;
      await bot.errorHandler(error);
    }
  }

  return {
    ...services,
    bot,
    calls,
    async send(text, from = {}) {
      const userId = from.userId ?? OWNER_ID;
      const chatType = from.chatType ?? 'private';
      const command = text.startsWith('/') ? text.split(/\s/)[0] : undefined;
      const entities: MessageEntity[] | undefined = command
        ? [{ type: 'bot_command', offset: 0, length: command.length }]
        : undefined;
      await sendUpdate({
        message: {
          message_id: ++nextMessageId,
          date: 1_760_000_000,
          chat:
            chatType === 'private'
              ? { id: userId, type: 'private', first_name: 'Owner' }
              : { id: -100123, type: 'group', title: 'Group' },
          from: user(userId),
          text,
          ...(entities ? { entities } : {}),
          ...(from.replyTo
            ? {
                reply_to_message: {
                  message_id: 1,
                  date: 1_760_000_000,
                  chat: { id: userId, type: 'private', first_name: 'Owner' },
                  from: from.replyTo.fromBot
                    ? { id: BOT_INFO.id, is_bot: true, first_name: BOT_INFO.first_name }
                    : user(userId),
                  text: from.replyTo.text,
                },
              }
            : {}),
        },
      } as Omit<Update, 'update_id'>);
    },
    sendUpdate,
    async click(data, messageId, userId = OWNER_ID) {
      await sendUpdate({
        callback_query: {
          id: `callback-${nextUpdateId}`,
          from: user(userId),
          chat_instance: 'instance',
          data,
          message: {
            message_id: messageId,
            date: 1_760_000_000,
            chat: { id: userId, type: 'private', first_name: 'Owner' },
            text: 'card',
          },
        },
      } as Omit<Update, 'update_id'>);
    },
    callsTo: (method) => calls.filter((call) => call.method === method),
    lastReply() {
      const replies = calls.filter((call) => call.method === 'sendMessage');
      const last = replies.at(-1);
      if (!last) throw new Error('No message was sent');
      return last;
    },
    clearCalls: () => {
      calls.length = 0;
    },
  };
}
