import type { Api } from 'grammy';
import type { Notifier } from '../../services/notifier.ts';
import type { Logger } from '../../shared/logger.ts';
import { eventView, type ViewContext } from './views.ts';

/**
 * Sends agent events to every allowed user's private chat. Delivery failures are
 * logged, never thrown (e.g. a user who has not started the bot yet).
 */
export function createTelegramNotifier(deps: {
  api: Api;
  recipients: readonly number[];
  view: ViewContext;
  logger: Logger;
}): Notifier {
  return {
    async notify(event) {
      const view = eventView(event, deps.view);
      await Promise.all(
        deps.recipients.map(async (chatId) => {
          try {
            await deps.api.sendMessage(chatId, view.text, { parse_mode: 'HTML' });
          } catch (error) {
            deps.logger.warn(
              { err: error, chatId, event: event.type },
              'Telegram notification failed',
            );
          }
        }),
      );
    },
  };
}
