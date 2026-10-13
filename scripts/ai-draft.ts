/**
 * Writes a draft post from an idea (several OpenAI requests: drafting, checks,
 * automatic revisions, review). The draft is stored for review and is never
 * published without your approval.
 * Usage: pnpm ai:draft <IDEA_ID>
 */
import { createEditorialServiceFromConfig } from '../src/services/editorial/factory.ts';
import { systemClock } from '../src/shared/clock.ts';
import { parsePublicId } from '../src/shared/ids.ts';
import { bootstrap, formatUsage } from './lib/bootstrap.ts';

const ideaId = parsePublicId(process.argv[2] ?? '');
if (!ideaId) {
  console.error('Usage: pnpm ai:draft <IDEA_ID>   (IDs are printed by pnpm ai:ideas)');
  process.exit(2);
}
const { startup, database, logger } = bootstrap();
const editorial = createEditorialServiceFromConfig({
  startup,
  db: database.db,
  clock: systemClock,
  logger,
});
if (!editorial) {
  console.error('AI generation is disabled (ai.enabled: false in your config).');
  process.exit(78);
}

console.log(`Drafting from idea ${ideaId} with ${startup.config.ai.models.drafting}…`);
const result = await editorial.draftFromIdea(ideaId);
database.close();

switch (result.kind) {
  case 'not_found':
    console.error(`No idea ${ideaId} (or it was discarded).`);
    process.exit(1);
    break;
  case 'already_drafted':
    console.log(
      `Idea ${ideaId} was already drafted${result.post ? ` as ${result.post.publicId}` : ''}.`,
    );
    break;
  case 'error':
    console.error(`Failed: ${result.message}`);
    process.exit(1);
    break;
  case 'failed':
    console.log('No draft passed the checks. Last problems:');
    for (const reason of result.reasons) console.log(`  - ${reason}`);
    console.log(formatUsage(result.usage));
    process.exit(1);
    break;
  case 'drafted': {
    const { post, review } = result;
    console.log(
      `\nDraft ${post.publicId} (${post.weightedLength}/${startup.config.publishing.maxWeightedLength} characters, attempt ${review.attempts}):`,
    );
    console.log(`\n${post.text}\n`);
    if (review.evaluation) {
      const { scores, recommendation } = review.evaluation;
      console.log(
        `Review: voice ${scores.voice}/5, value ${scores.value}/5, clarity ${scores.clarity}/5 → ${recommendation}`,
      );
    }
    for (const warning of review.warnings) console.log(`  ⚠ ${warning.message}`);
    for (const claim of review.claims) console.log(`  claim [${claim.basis}] ${claim.claim}`);
    console.log(`\n${formatUsage(result.usage)}`);
    console.log(
      'Saved as a draft. It cannot be published until you approve it (Telegram review arrives in Milestone 5).',
    );
    break;
  }
}
