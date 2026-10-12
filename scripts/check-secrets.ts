/**
 * Pre-commit safety check. Scans every file git would commit (tracked or
 * untracked-but-not-ignored) for:
 *   1. private paths that are not ignored (.env, local/, databases),
 *   2. credential-looking strings,
 *   3. the actual credential values from your local .env.
 * Reports file and line only, never the matched value. Exits 1 on any finding.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEnvironment } from '../src/shared/dotenv.ts';
import { findSecrets } from '../src/shared/secret-patterns.ts';
import { isPrivatePath } from './private-paths.ts';

const SECRET_VARIABLES = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_TOKEN_SECRET',
];
const MAX_FILE_BYTES = 1_000_000;

const root = resolve(import.meta.dirname, '..');

function listCommittableFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((file) => file !== '');
  } catch {
    console.error('check:secrets must run inside the git repository.');
    process.exit(2);
  }
}

function localSecretValues(): string[] {
  // Read the .env file only (not the shell environment) to learn your real values.
  const fileEnv = readEnvironment(root, {});
  return SECRET_VARIABLES.map((name) => fileEnv[name]?.trim()).filter(
    (value): value is string => value !== undefined && value.length >= 8,
  );
}

const findings: string[] = [];
const knownSecrets = localSecretValues();

for (const file of listCommittableFiles()) {
  if (isPrivatePath(file)) {
    findings.push(`${file}: private file is not ignored by git`);
    continue;
  }

  const absolutePath = join(root, file);
  let content: string;
  try {
    if (statSync(absolutePath).size > MAX_FILE_BYTES) continue;
    content = readFileSync(absolutePath, 'utf8');
  } catch {
    continue; // deleted from the working tree
  }
  if (content.includes('\0')) continue; // binary

  content.split('\n').forEach((line, index) => {
    for (const match of findSecrets(line)) {
      findings.push(`${file}:${index + 1}: possible ${match.name}`);
    }
    if (knownSecrets.some((secret) => line.includes(secret))) {
      findings.push(`${file}:${index + 1}: contains a credential value from your .env`);
    }
  });
}

if (findings.length > 0) {
  console.error(`check:secrets found ${findings.length} problem(s):`);
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    '\nRemove the value (and rotate the credential if it was ever committed or pushed). See README.md > Security.',
  );
  process.exit(1);
}
console.log('check:secrets: no private files or credentials found in committable files.');
