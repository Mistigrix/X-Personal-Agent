/**
 * Telegram message rendering (HTML parse mode). Pure functions: no I/O, no
 * business decisions. Post text is always HTML-escaped and shown verbatim.
 */
import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import type { PostStatus } from '../../domain/post.ts';
import type { PublishMode } from '../../domain/publication.ts';
import type { Slot } from '../../domain/scheduling.ts';
import type { TextAnalysis, TextError, TextWarning } from '../../domain/text.ts';
import type { AgentEvent, EventPost } from '../../services/notifier.ts';
import type { MarkPublishedResult, RetryResult } from '../../services/publisher-service.ts';
import type {
  CancelResult,
  ConfirmResult,
  PostView,
  QueueSummary,
} from '../../services/queue-service.ts';
import { encodeCallback } from './callbacks.ts';

export interface View {
  text: string;
  keyboard?: InlineKeyboard;
}

export interface ViewContext {
  timezone: string;
  maxWeightedLength: number;
  publishMode: PublishMode;
  /** False until automatic publication exists; views then say posts stay queued. */
  publishingAvailable: boolean;
}

/** Telegram messages are limited to 4096 UTF-16 code units; long previews are shortened. */
const MAX_QUOTED_UNITS = 3000;
const SNIPPET_CHARACTERS = 70;

const STATUS_LABELS: Record<PostStatus, string> = {
  pending_confirmation: 'awaiting your confirmation',
  draft: 'draft awaiting review',
  scheduled: 'scheduled',
  publishing: 'publishing now',
  published: 'published',
  uncertain: 'outcome uncertain',
  failed: 'failed',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function formatLocalTime(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone })
    .setLocale('en-GB')
    .toFormat('ccc d LLL, HH:mm');
}

/** Shortens text to at most `maxUnits` UTF-16 code units without splitting a character. */
function truncateUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let result = '';
  for (const character of text) {
    if (result.length + character.length > maxUnits) break;
    result += character;
  }
  return result;
}

function quote(text: string): string {
  const shown =
    text.length > MAX_QUOTED_UNITS
      ? `${truncateUnits(text, MAX_QUOTED_UNITS)}\n… (preview shortened; the full text is stored)`
      : text;
  return `<blockquote>${escapeHtml(shown)}</blockquote>`;
}

function snippet(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  const characters = Array.from(firstLine);
  const short =
    characters.length > SNIPPET_CHARACTERS
      ? `${characters.slice(0, SNIPPET_CHARACTERS).join('')}…`
      : firstLine;
  return escapeHtml(short);
}

function modeLine(context: ViewContext): string {
  return context.publishMode === 'dry-run'
    ? '🧪 Mode: <b>dry run</b>. Nothing is sent to X.'
    : '🚀 Mode: <b>live</b>. Posts are published on X.';
}

function availabilityNote(context: ViewContext): string[] {
  return context.publishingAvailable
    ? []
    : ['ℹ️ Automatic publishing is not available yet: queued posts stay in the queue.'];
}

const COMMANDS_HELP = [
  '/queue: list queued posts',
  '/cancel ID: cancel a queued post',
  '/status: mode, pause state and next publication',
  '/pause: pause automatic publication',
  '/resume: resume automatic publication',
  '/add: how to submit a post',
  '/help: this list',
].join('\n');

export function welcomeView(context: ViewContext): View {
  return {
    text: [
      '👋 <b>Your X posting agent</b>',
      '',
      'Send me any text and it becomes a post on X, published <b>exactly as written</b> in one of your publication windows.',
      'AI-drafted posts (coming later) will always need your explicit approval.',
      '',
      modeLine(context),
      ...availabilityNote(context),
      '',
      COMMANDS_HELP,
    ].join('\n'),
  };
}

export function helpView(): View {
  return { text: `<b>Commands</b>\n${COMMANDS_HELP}\n\nAny other text message is a new post.` };
}

export function addHelpView(context: ViewContext): View {
  return {
    text: [
      '<b>Submitting a post</b>',
      'Send the text as a normal message (not a command). It is stored exactly as written: no rewriting, no correction.',
      `Maximum length: ${context.maxWeightedLength} characters as counted by X (links count 23, emoji count 2).`,
      'You will see a preview with its length and its publication time before it is queued.',
    ].join('\n'),
  };
}

function describeError(error: TextError): string {
  switch (error.kind) {
    case 'empty':
      return 'The text is empty.';
    case 'too_long':
      return `It is ${error.weightedLength}/${error.maxWeightedLength} characters as counted by X (links count 23, emoji count 2).`;
    case 'invalid_characters':
      return 'It contains characters X does not accept (byte-order marks or non-characters).';
    case 'urls_blocked':
      return 'It contains a link, and links are blocked by your configuration (publishing.urlPolicy).';
  }
}

function describeWarning(warning: TextWarning): string {
  switch (warning.kind) {
    case 'contains_urls':
      return `⚠️ Contains ${warning.count === 1 ? 'a link' : `${warning.count} links`}. Posts with links cost much more on the X API.`;
    case 'possible_secret':
      return `⚠️ May contain a credential (${escapeHtml(warning.names.join(', '))}). Never publish secrets.`;
  }
}

export function invalidPostView(analysis: TextAnalysis): View {
  return {
    text: [
      '❌ <b>Not queued.</b>',
      ...analysis.errors.map((error) => `• ${describeError(error)}`),
      '',
      'Nothing was saved. Edit the text and send it again.',
    ].join('\n'),
  };
}

export function previewView(
  post: PostView,
  analysis: TextAnalysis,
  projectedSlot: Slot | null,
  context: ViewContext,
): View {
  const timing = projectedSlot
    ? `🕒 If queued now: ${formatLocalTime(projectedSlot.at, context.timezone)}`
    : '🕒 No free publication slot in the next 12 months.';
  return {
    text: [
      `📝 <b>New post ${post.publicId}</b> · ${analysis.weightedLength}/${context.maxWeightedLength} characters`,
      quote(post.text),
      ...analysis.warnings.map(describeWarning),
      timing,
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text(
        '✅ Queue',
        encodeCallback({ action: 'queue', publicId: post.publicId, version: post.version }),
      )
      .text(
        '🗑 Discard',
        encodeCallback({ action: 'discard', publicId: post.publicId, version: post.version }),
      ),
  };
}

export function queuedView(post: PostView, context: ViewContext, paused: boolean): View {
  const when = post.scheduledAt
    ? formatLocalTime(post.scheduledAt, context.timezone)
    : 'unscheduled';
  return {
    text: [
      `✅ <b>Queued ${post.publicId}</b> for ${when} (${escapeHtml(context.timezone)})`,
      quote(post.text),
      ...(paused ? ['⏸ Publication is paused: use /resume to publish on schedule.'] : []),
      ...availabilityNote(context),
      `To cancel: /cancel ${post.publicId}`,
    ].join('\n'),
  };
}

export function discardedView(post: PostView): View {
  return {
    text: `🗑 <b>Discarded ${post.publicId}.</b> Nothing will be published.\n${quote(post.text)}`,
  };
}

export function queueFullView(): View {
  return {
    text: '❌ <b>Not queued.</b> There is no free publication slot in the next 12 months. Cancel some posts or add publication windows.',
  };
}

/** Card shown after the [Queue] button, or null when the card should stay as is. */
export function confirmOutcome(
  result: ConfirmResult,
  context: ViewContext,
  paused: boolean,
): { toast: string; card: View | null } {
  switch (result.kind) {
    case 'queued':
      return {
        toast: `Queued for ${formatLocalTime(result.slot.at, context.timezone)}`,
        card: queuedView(result.post, context, paused),
      };
    case 'already_queued':
      return { toast: 'Already queued', card: queuedView(result.post, context, paused) };
    case 'not_pending':
      return { toast: `This post is ${STATUS_LABELS[result.post.status]}.`, card: null };
    case 'outdated':
      return { toast: 'This card is outdated.', card: null };
    case 'queue_full':
      return { toast: 'No free publication slot.', card: null };
    case 'not_found':
      return { toast: 'This post no longer exists.', card: null };
  }
}

export function discardOutcome(result: CancelResult): { toast: string; card: View | null } {
  switch (result.kind) {
    case 'cancelled':
      return { toast: 'Discarded', card: discardedView(result.post) };
    case 'already_cancelled':
      return { toast: 'Already discarded', card: discardedView(result.post) };
    case 'not_cancellable':
      return { toast: `This post is ${STATUS_LABELS[result.post.status]}.`, card: null };
    case 'outdated':
      return { toast: 'This card is outdated.', card: null };
    case 'not_found':
      return { toast: 'This post no longer exists.', card: null };
  }
}

export function cancelResultView(result: CancelResult): View {
  switch (result.kind) {
    case 'cancelled':
      return { text: `🗑 <b>Cancelled ${result.post.publicId}.</b> It will not be published.` };
    case 'already_cancelled':
      return { text: `${result.post.publicId} was already cancelled.` };
    case 'not_cancellable':
      return {
        text: `${result.post.publicId} cannot be cancelled: it is ${STATUS_LABELS[result.post.status]}.`,
      };
    case 'outdated':
      return { text: `${result.post.publicId} changed since it was displayed. Check /queue.` };
    case 'not_found':
      return { text: 'No post with this ID. IDs are listed in /queue.' };
  }
}

export function cancelUsageView(): View {
  return {
    text: 'Usage: <code>/cancel ID</code>, for example <code>/cancel P7K2QX</code>. IDs are listed in /queue.',
  };
}

export function queueView(
  queue: { posts: PostView[]; total: number },
  context: ViewContext,
  paused: boolean,
): View {
  if (queue.total === 0) {
    return { text: '📭 The queue is empty. Send me a text to create a post.' };
  }
  const lines = [`🗓 <b>Queue</b> (${queue.total}) · times in ${escapeHtml(context.timezone)}`];
  if (paused) lines.push('⏸ Publication is paused (/resume).');
  for (const post of queue.posts) {
    const when = post.scheduledAt
      ? `${formatLocalTime(post.scheduledAt, context.timezone)} · `
      : '';
    lines.push(
      '',
      `<code>${post.publicId}</code> · ${when}${STATUS_LABELS[post.status]}`,
      `“${snippet(post.text)}”`,
    );
  }
  if (queue.total > queue.posts.length)
    lines.push('', `…and ${queue.total - queue.posts.length} more.`);
  return { text: lines.join('\n') };
}

export function statusView(summary: QueueSummary, context: ViewContext, paused: boolean): View {
  const count = (status: PostStatus) => summary.counts[status] ?? 0;
  const next = summary.nextScheduled;
  const lines = [
    '<b>Status</b>',
    modeLine(context),
    paused ? '⏸ Publication: <b>paused</b> (/resume)' : '▶️ Publication: <b>active</b>',
    ...availabilityNote(context),
    '',
    `Scheduled: ${count('scheduled')}`,
    `Awaiting your confirmation: ${count('pending_confirmation')}`,
  ];
  if (count('uncertain') > 0) lines.push(`⚠️ Outcome uncertain: ${count('uncertain')}`);
  if (count('failed') > 0) lines.push(`❌ Failed: ${count('failed')}`);
  lines.push(
    next?.scheduledAt
      ? `Next publication: <code>${next.publicId}</code> on ${formatLocalTime(next.scheduledAt, context.timezone)}`
      : 'Next publication: none scheduled',
  );
  return { text: lines.join('\n') };
}

export function pauseView(changed: boolean): View {
  return {
    text: changed
      ? '⏸ <b>Automatic publication paused.</b> Queued posts stay in the queue. Use /resume to continue.'
      : 'Publication was already paused. Use /resume to continue.',
  };
}

export function resumeView(changed: boolean): View {
  return {
    text: changed ? '▶️ <b>Automatic publication resumed.</b>' : 'Publication is not paused.',
  };
}

export function unknownCommandView(): View {
  return { text: 'Unknown command. See /help.' };
}

export function unsupportedMessageView(): View {
  return { text: 'Only text posts are supported for now. Send the post as a text message.' };
}

export function editedMessageView(): View {
  return {
    text: 'Edits to messages already sent are not applied. To change a queued post, /cancel it and send the corrected text.',
  };
}

export function errorView(): View {
  return {
    text: '⚠️ Something went wrong while handling your message. Nothing was published. Please try again.',
  };
}

function postLink(xPostId: string | null): string[] {
  return xPostId ? [`https://x.com/i/status/${encodeURIComponent(xPostId)}`] : [];
}

function decisionKeyboard(post: EventPost, options: { markPublished: boolean }): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(
    '🔁 Publish again',
    encodeCallback({ action: 'retry', publicId: post.publicId, version: post.version }),
  );
  if (options.markPublished) {
    keyboard.text(
      '✅ It is on X',
      encodeCallback({ action: 'markPublished', publicId: post.publicId, version: post.version }),
    );
  }
  return keyboard
    .row()
    .text(
      '🗑 Cancel',
      encodeCallback({ action: 'cancel', publicId: post.publicId, version: post.version }),
    );
}

export function eventView(event: AgentEvent, context: ViewContext): View {
  switch (event.type) {
    case 'started':
      return {
        text: [
          '🟢 <b>Agent started.</b>',
          modeLine(context),
          event.paused ? '⏸ Publication is paused (/resume).' : '▶️ Publication is active.',
          ...availabilityNote(context),
          `Posts in the queue: ${event.queued}`,
        ].join('\n'),
      };
    case 'published':
      return {
        text: event.dryRun
          ? [
              `🧪 <b>[DRY RUN] ${event.post.publicId} would have been published now.</b> Nothing was sent to X.`,
              quote(event.post.text),
            ].join('\n')
          : [
              `✅ <b>Published ${event.post.publicId} on X.</b>`,
              quote(event.post.text),
              ...postLink(event.xPostId),
            ].join('\n'),
      };
    case 'publication_failed':
      return {
        text: [
          `❌ <b>${event.post.publicId} could not be published.</b>`,
          escapeHtml(event.reason),
          quote(event.post.text),
        ].join('\n'),
        keyboard: decisionKeyboard(event.post, { markPublished: false }),
      };
    case 'publication_uncertain':
      return {
        text: [
          `⚠️ <b>Publication of ${event.post.publicId} is uncertain.</b>`,
          escapeHtml(event.reason),
          'It may or may not be on X. Nothing will be re-sent automatically: I am checking your timeline first.',
          quote(event.post.text),
        ].join('\n'),
      };
    case 'publication_confirmed':
      return {
        text: [
          `✅ <b>Confirmed: ${event.post.publicId} is on X.</b>`,
          ...postLink(event.xPostId),
        ].join('\n'),
      };
    case 'publication_not_found':
      return event.rescheduledAt
        ? {
            text: [
              `⚠️ <b>${event.post.publicId} was not found on X</b> after an uncertain attempt.`,
              `It was rescheduled automatically for ${formatLocalTime(event.rescheduledAt, context.timezone)}.`,
              quote(event.post.text),
            ].join('\n'),
          }
        : {
            text: [
              `⚠️ <b>${event.post.publicId} was not found on X</b> (or your timeline could not be checked${event.reason ? `: ${escapeHtml(event.reason)}` : ''}).`,
              'Please check your profile, then decide:',
              quote(event.post.text),
            ].join('\n'),
            keyboard: decisionKeyboard(event.post, { markPublished: true }),
          };
    case 'rescheduled':
      return {
        text: [
          '🕒 <b>Posts that missed their time were moved:</b>',
          ...event.moves.map(
            (move) =>
              `<code>${move.publicId}</code> → ${formatLocalTime(move.to, context.timezone)}`,
          ),
        ].join('\n'),
      };
  }
}

export function retryOutcome(
  result: RetryResult,
  context: ViewContext,
): { toast: string; card: View | null } {
  switch (result.kind) {
    case 'rescheduled': {
      const when = formatLocalTime(result.slot.at, context.timezone);
      return {
        toast: `Rescheduled for ${when}`,
        card: {
          text: `🔁 <b>${result.post.publicId} rescheduled</b> for ${when}.\n${quote(result.post.text)}`,
        },
      };
    }
    case 'not_retryable':
      return { toast: `This post is ${STATUS_LABELS[result.post.status]}.`, card: null };
    case 'outdated':
      return { toast: 'This card is outdated.', card: null };
    case 'queue_full':
      return { toast: 'No free publication slot.', card: null };
    case 'not_found':
      return { toast: 'This post no longer exists.', card: null };
  }
}

export function markPublishedOutcome(result: MarkPublishedResult): {
  toast: string;
  card: View | null;
} {
  switch (result.kind) {
    case 'marked':
      return {
        toast: 'Marked as published',
        card: {
          text: `✅ <b>${result.post.publicId} marked as published.</b> It will not be sent again.`,
        },
      };
    case 'not_uncertain':
      return { toast: `This post is ${STATUS_LABELS[result.post.status]}.`, card: null };
    case 'outdated':
      return { toast: 'This card is outdated.', card: null };
    case 'not_found':
      return { toast: 'This post no longer exists.', card: null };
  }
}

export function cancelOutcome(result: CancelResult): { toast: string; card: View | null } {
  switch (result.kind) {
    case 'cancelled':
      return {
        toast: 'Cancelled',
        card: { text: `🗑 <b>${result.post.publicId} cancelled.</b> It will not be published.` },
      };
    case 'already_cancelled':
      return { toast: 'Already cancelled', card: null };
    case 'not_cancellable':
      return { toast: `This post is ${STATUS_LABELS[result.post.status]}.`, card: null };
    case 'outdated':
      return { toast: 'This card is outdated.', card: null };
    case 'not_found':
      return { toast: 'This post no longer exists.', card: null };
  }
}
