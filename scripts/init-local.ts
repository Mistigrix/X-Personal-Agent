/**
 * Creates the private local setup from the committed examples, without ever
 * overwriting existing files:
 *   .env.example               -> .env
 *   config/agent.example.yaml  -> local/agent.yaml
 *   examples/profile/*.md      -> local/profile/
 */
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const created: string[] = [];
const kept: string[] = [];

function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    created.push(`${relative(root, path)}/`);
  }
}

function copyIfMissing(from: string, to: string, mode: number): void {
  if (existsSync(to)) {
    kept.push(relative(root, to));
    return;
  }
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  chmodSync(to, mode);
  created.push(relative(root, to));
}

const localDir = join(root, 'local');
ensureDirectory(localDir);
ensureDirectory(join(localDir, 'data'));
ensureDirectory(join(localDir, 'profile'));
ensureDirectory(join(localDir, 'prompts'));

copyIfMissing(join(root, '.env.example'), join(root, '.env'), 0o600);
copyIfMissing(join(root, 'config', 'agent.example.yaml'), join(localDir, 'agent.yaml'), 0o600);

const exampleProfileDir = join(root, 'examples', 'profile');
for (const file of readdirSync(exampleProfileDir).filter((name) => name.endsWith('.md'))) {
  copyIfMissing(join(exampleProfileDir, file), join(localDir, 'profile', file), 0o600);
}

console.log('Local setup');
for (const path of created) console.log(`  created  ${path}`);
for (const path of kept) console.log(`  kept     ${path} (already exists, not modified)`);
console.log(`
Next steps:
  1. Edit .env: set TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS and OPENAI_API_KEY.
     Keep PUBLISH_MODE=dry-run until your X credentials are verified.
  2. Review local/agent.yaml (timezone, publication windows, models, editorial settings).
  3. Rewrite every file in local/profile/ with your own information and delete its
     "example-profile" line. The agent refuses to start with the fictional content.
     (Or set ai.enabled: false to start with personal posts only.)
  4. Run: pnpm start

Everything in local/ and .env is gitignored. Never commit it.`);
