import type { Context, MiddlewareFn } from 'grammy';
import type { Logger } from '../../shared/logger.ts';

/**
 * Lets an update through only if it comes from an allowed user in a private chat.
 * Anything else is dropped without a reply (a reply would confirm the bot exists),
 * and only the sender's ID is logged, never the message content.
 */
export function authorize(
  allowedUserIds: readonly number[],
  logger: Logger,
): MiddlewareFn<Context> {
  const allowed = new Set(allowedUserIds);
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== undefined && allowed.has(userId) && ctx.chat?.type === 'private') {
      await next();
      return;
    }
    logger.warn(
      { userId, chatType: ctx.chat?.type, updateId: ctx.update.update_id },
      'Ignored Telegram update from an unauthorized user or chat',
    );
  };
}
