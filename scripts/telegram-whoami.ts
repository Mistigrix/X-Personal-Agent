/**
 * Prints the Telegram user ID of whoever messages the bot, to set
 * TELEGRAM_ALLOWED_USER_IDS. The ID is printed on this console only; the bot
 * never replies. Stop the agent first: only one process can receive updates.
 */
import { resolve } from 'node:path';
import { Bot, GrammyError } from 'grammy';
import { readEnvironment } from '../src/shared/dotenv.ts';

const root = resolve(import.meta.dirname, '..');
const token = readEnvironment(root).TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env. Create a bot with @BotFather first.');
  process.exit(78);
}

const bot = new Bot(token);
bot.on('message', (ctx) => {
  const username = ctx.from?.username ? `@${ctx.from.username}` : '(no username)';
  console.log(`User ID: ${ctx.from?.id}  ${username}  chat: ${ctx.chat.type}`);
});

const stop = () => void bot.stop();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await bot.start({
    allowed_updates: ['message'],
    onStart: (info) => {
      console.log(`Listening as @${info.username}. Send any message to the bot from Telegram.`);
      console.log('Copy your user ID into TELEGRAM_ALLOWED_USER_IDS in .env, then press Ctrl+C.');
    },
  });
} catch (error) {
  if (error instanceof GrammyError && error.error_code === 401) {
    console.error(
      'Telegram rejected TELEGRAM_BOT_TOKEN (401 Unauthorized). Check the token from @BotFather.',
    );
  } else if (error instanceof GrammyError && error.error_code === 409) {
    console.error(
      'Another process (probably the agent) is receiving updates for this bot. Stop it first.',
    );
  } else {
    console.error('Telegram polling failed:', error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
