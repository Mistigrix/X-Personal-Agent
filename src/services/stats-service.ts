/**
 * Activity statistics for /stats, computed from the database. Cost figures are
 * estimates based on configurable prices, not billing data.
 */
import { sql } from 'drizzle-orm';
import twitterText from 'twitter-text';
import type { AppDatabase } from '../db/client.ts';
import { countByStatuses } from '../db/repositories/posts.ts';
import type { PostStatus } from '../domain/post.ts';
import type { Clock } from '../shared/clock.ts';

export interface PeriodStats {
  days: number;
  published: { personal: number; ai: number; dryRun: number; withLinks: number };
  aiReview: { generated: number; approved: number; rejected: number };
  openAiTokens: { input: number; cachedInput: number; output: number };
  reconciliationChecks: number;
  estimatedXCostUsd: number;
}

export interface Stats {
  periods: PeriodStats[];
  open: Partial<Record<PostStatus, number>>;
}

export interface StatsService {
  compute(periods?: readonly number[]): Stats;
}

const AI_JOBS = ['generate-ideas', 'draft-from-idea', 'regenerate-draft'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function createStatsService(deps: {
  db: AppDatabase;
  clock: Clock;
  prices: { xPostUsd: number; xPostWithUrlUsd: number };
}): StatsService {
  const { db, clock, prices } = deps;

  function period(days: number): PeriodStats {
    const since = clock.now().getTime() - days * DAY_MS;

    const published = db.all<{ source: string; dry_run: number; text: string }>(sql`
      SELECT p.source AS source,
             COALESCE((SELECT a.dry_run FROM publication_attempts a
                       WHERE a.post_id = p.id ORDER BY a.id DESC LIMIT 1), 0) AS dry_run,
             v.text AS text
      FROM posts p
      JOIN post_versions v ON v.post_id = p.id AND v.version = p.current_version
      WHERE p.status = 'published' AND p.published_at >= ${since}`);
    const live = published.filter((row) => row.dry_run === 0);
    const withLinks = live.filter((row) => twitterText.extractUrls(row.text).length > 0).length;

    const [generated] = db.all<{ total: number }>(sql`
      SELECT COUNT(*) AS total FROM post_versions
      WHERE origin IN ('ai_generated', 'ai_regenerated') AND created_at >= ${since}`);
    const decisions = db.all<{ decision: string; total: number }>(sql`
      SELECT decision, COUNT(*) AS total FROM approvals
      WHERE decided_at >= ${since} GROUP BY decision`);
    const [tokens] = db.all<{ input: number; cached: number; output: number }>(sql`
      SELECT COALESCE(SUM(json_extract(meta, '$.usage.inputTokens')), 0) AS input,
             COALESCE(SUM(json_extract(meta, '$.usage.cachedInputTokens')), 0) AS cached,
             COALESCE(SUM(json_extract(meta, '$.usage.outputTokens')), 0) AS output
      FROM job_runs
      WHERE job_name IN (${sql.join(
        AI_JOBS.map((name) => sql`${name}`),
        sql`, `,
      )})
        AND started_at >= ${since}`);
    const [checks] = db.all<{ total: number }>(sql`
      SELECT COALESCE(SUM(reconcile_checks), 0) AS total FROM publication_attempts
      WHERE dry_run = 0 AND started_at >= ${since}`);

    const decision = (name: string) => decisions.find((row) => row.decision === name)?.total ?? 0;
    return {
      days,
      published: {
        personal: live.filter((row) => row.source === 'personal').length,
        ai: live.filter((row) => row.source === 'ai').length,
        dryRun: published.length - live.length,
        withLinks,
      },
      aiReview: {
        generated: generated?.total ?? 0,
        approved: decision('approved'),
        rejected: decision('rejected'),
      },
      openAiTokens: {
        input: tokens?.input ?? 0,
        cachedInput: tokens?.cached ?? 0,
        output: tokens?.output ?? 0,
      },
      reconciliationChecks: checks?.total ?? 0,
      estimatedXCostUsd:
        (live.length - withLinks) * prices.xPostUsd + withLinks * prices.xPostWithUrlUsd,
    };
  }

  return {
    compute(periods = [7, 30]) {
      return {
        periods: periods.map(period),
        open: countByStatuses(db, [
          'draft',
          'pending_confirmation',
          'scheduled',
          'failed',
          'uncertain',
        ]),
      };
    },
  };
}
