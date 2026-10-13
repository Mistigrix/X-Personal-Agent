/**
 * Generates post ideas from your editorial profile (one OpenAI request).
 * Usage: pnpm ai:ideas [count]
 */
import { createEditorialServiceFromConfig } from '../src/services/editorial/factory.ts';
import { systemClock } from '../src/shared/clock.ts';
import { bootstrap, formatUsage } from './lib/bootstrap.ts';

const { startup, database, logger } = bootstrap();
const count = Number(process.argv[2] ?? startup.config.ai.ideasPerRequest);
if (!Number.isInteger(count) || count < 1 || count > 10) {
  console.error('Usage: pnpm ai:ideas [count]   (1 to 10)');
  process.exit(2);
}
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
if (startup.profile?.isDemo) console.log('Using the fictional DEMO profile (examples/profile).\n');

console.log(`Generating ${count} idea(s) with ${startup.config.ai.models.ideas}…`);
const result = await editorial.generateIdeas(count);
database.close();
if (result.kind === 'error') {
  console.error(`Failed: ${result.message}`);
  process.exit(1);
}

for (const idea of result.ideas) {
  console.log(`\n${idea.publicId}  [${idea.language}] ${idea.category}`);
  console.log(`  ${idea.topic}: ${idea.angle}`);
  if (idea.rationale) console.log(`  Why: ${idea.rationale}`);
  console.log(`  Relies on: ${idea.profileSections.join(', ') || 'unspecified'}`);
}
for (const skipped of result.discarded)
  console.log(`\nSkipped "${skipped.topic}": ${skipped.reason}`);
console.log(`\n${formatUsage(result.usage)}`);
if (result.ideas[0]) console.log(`Next: pnpm ai:draft ${result.ideas[0].publicId}`);
