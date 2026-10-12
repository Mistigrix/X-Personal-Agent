import { describe, expect, it } from 'vitest';
import { analyzeText } from '../../domain/text.ts';
import type { PostView } from '../../services/queue-service.ts';
import {
  escapeHtml,
  eventView,
  formatLocalTime,
  previewView,
  queueView,
  type ViewContext,
} from './views.ts';

const CONTEXT: ViewContext = {
  timezone: 'Africa/Abidjan',
  maxWeightedLength: 280,
  publishMode: 'dry-run',
  publishingAvailable: false,
};

function post(text: string, overrides: Partial<PostView> = {}): PostView {
  return {
    publicId: 'P7K2QX',
    source: 'personal',
    status: 'pending_confirmation',
    version: 1,
    text,
    weightedLength: 0,
    scheduledAt: null,
    createdAt: new Date('2026-10-12T07:00:00Z'),
    ...overrides,
  };
}

describe('views', () => {
  it('escapes HTML in user text', () => {
    expect(escapeHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });

  it('formats times in the configured timezone', () => {
    expect(formatLocalTime(new Date('2026-10-14T08:47:00Z'), 'Africa/Abidjan')).toBe(
      'Wed 14 Oct, 08:47',
    );
    expect(formatLocalTime(new Date('2026-10-14T08:47:00Z'), 'Europe/Paris')).toBe(
      'Wed 14 Oct, 10:47',
    );
  });

  it('shows the exact text escaped, with versioned buttons', () => {
    const text = 'Use <script> & "quotes"';
    const view = previewView(
      post(text),
      analyzeText(text, { maxWeightedLength: 280, urlPolicy: 'confirm' }),
      null,
      CONTEXT,
    );
    expect(view.text).toContain('<blockquote>Use &lt;script&gt; &amp; "quotes"</blockquote>');
    const buttons = view.keyboard?.inline_keyboard
      .flat()
      .map((button) => ('callback_data' in button ? button.callback_data : ''));
    expect(buttons).toEqual(['q:P7K2QX:1', 'x:P7K2QX:1']);
  });

  it('shortens very long previews without splitting characters', () => {
    const text = '😀'.repeat(5000);
    const view = previewView(
      post(text),
      analyzeText(text, { maxWeightedLength: 25_000, urlPolicy: 'allow' }),
      null,
      CONTEXT,
    );
    expect(view.text.length).toBeLessThan(4096);
    expect(view.text).toContain('preview shortened');
    expect(view.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('lists queued posts with local times and remaining count', () => {
    const view = queueView(
      {
        posts: [
          post('First line\nsecond line', {
            status: 'scheduled',
            scheduledAt: new Date('2026-10-12T08:15:00Z'),
          }),
        ],
        total: 3,
      },
      CONTEXT,
      true,
    );
    expect(view.text).toContain('<code>P7K2QX</code> · Mon 12 Oct, 08:15 · scheduled');
    expect(view.text).toContain('“First line”');
    expect(view.text).toContain('…and 2 more.');
    expect(view.text).toContain('paused');
  });
});

describe('publication event views', () => {
  const eventPost = { publicId: 'P7K2QX', version: 3, text: 'Hello <X>' };
  const buttons = (view: ReturnType<typeof eventView>) =>
    view.keyboard?.inline_keyboard
      .flat()
      .map((button) => ('callback_data' in button ? button.callback_data : '')) ?? [];

  it('links to a published post', () => {
    const view = eventView(
      { type: 'published', post: eventPost, xPostId: '1844', dryRun: false },
      CONTEXT,
    );
    expect(view.text).toContain('Published P7K2QX on X');
    expect(view.text).toContain('https://x.com/i/status/1844');
    expect(view.text).toContain('Hello &lt;X&gt;');
  });

  it('makes dry-run publications unmistakable', () => {
    const view = eventView(
      { type: 'published', post: eventPost, xPostId: null, dryRun: true },
      CONTEXT,
    );
    expect(view.text).toContain('[DRY RUN]');
    expect(view.text).toContain('Nothing was sent to X');
  });

  it('offers retry or cancel for a failure, with the shown version', () => {
    const view = eventView(
      { type: 'publication_failed', post: eventPost, reason: 'Invalid.' },
      CONTEXT,
    );
    expect(buttons(view)).toEqual(['r:P7K2QX:3', 'c:P7K2QX:3']);
  });

  it('asks the user to decide when an uncertain post was not found', () => {
    const view = eventView(
      { type: 'publication_not_found', post: eventPost, reason: null, rescheduledAt: null },
      CONTEXT,
    );
    expect(buttons(view)).toEqual(['r:P7K2QX:3', 'm:P7K2QX:3', 'c:P7K2QX:3']);
  });

  it('promises no automatic resend while a publication is uncertain', () => {
    const view = eventView(
      { type: 'publication_uncertain', post: eventPost, reason: 'Timeout.' },
      CONTEXT,
    );
    expect(view.text).toContain('Nothing will be re-sent automatically');
    expect(buttons(view)).toEqual([]);
  });
});
