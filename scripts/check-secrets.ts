/**
 * Safety check before committing or publishing the repository. Looks for:
 *   1. private paths that are not ignored (.env, local/, databases),
 *   2. credential-looking strings,
 *   3. the actual credential values from your local .env.
 *
 * Default: every file git would commit (tracked, or untracked but not ignored).
 * `--history`: every file of every commit, since a secret removed later is still
 * public once the history is pushed.
 *
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
const scanHistory = process.argv.includes('--history');

function git(args: string[], input?: string): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    });
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

function scanContent(label: string, content: string): void {
  if (content.includes('\0')) return; // binary
  content.split('\n').forEach((line, index) => {
    for (const match of findSecrets(line)) {
      findings.push(`${label}:${index + 1}: possible ${match.name}`);
    }
    if (knownSecrets.some((secret) => line.includes(secret))) {
      findings.push(`${label}:${index + 1}: contains a credential value from your .env`);
    }
  });
}

function scanWorkingTree(): number {
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((file) => file !== '');
  for (const file of files) {
    if (isPrivatePath(file)) {
      findings.push(`${file}: private file is not ignored by git`);
      continue;
    }
    const absolutePath = join(root, file);
    try {
      if (statSync(absolutePath).size > MAX_FILE_BYTES) continue;
      scanContent(file, readFileSync(absolutePath, 'utf8'));
    } catch {
      // deleted from the working tree
    }
  }
  return files.length;
}

function scanAllCommits(): number {
  // Every object reachable from any ref, with the path it was first seen at.
  const objects = git(['rev-list', '--all', '--objects'])
    .split('\n')
    .map((line) => {
      const space = line.indexOf(' ');
      return space === -1 ? null : { sha: line.slice(0, space), path: line.slice(space + 1) };
    })
    .filter((entry): entry is { sha: string; path: string } => entry !== null && entry.path !== '');
  const types = git(
    ['cat-file', '--batch-check=%(objecttype) %(objectsize)'],
    `${objects.map((entry) => entry.sha).join('\n')}\n`,
  ).split('\n');

  let blobs = 0;
  objects.forEach((entry, index) => {
    const [type, size] = (types[index] ?? '').split(' ');
    if (type === 'tree' && isPrivatePath(entry.path)) {
      findings.push(
        `history ${entry.path} (${entry.sha.slice(0, 8)}): private directory was committed`,
      );
    }
    if (type !== 'blob') return;
    blobs += 1;
    const label = `history ${entry.path} (${entry.sha.slice(0, 8)})`;
    if (isPrivatePath(entry.path)) {
      findings.push(`${label}: private file was committed`);
      return;
    }
    if (Number(size) > MAX_FILE_BYTES) return;
    scanContent(label, git(['cat-file', '-p', entry.sha]));
  });
  return blobs;
}

const scanned = scanHistory ? scanAllCommits() : scanWorkingTree();
const scope = scanHistory
  ? `${scanned} file versions in the git history`
  : `${scanned} committable files`;

if (findings.length > 0) {
  console.error(`check:secrets found ${findings.length} problem(s) in ${scope}:`);
  for (const finding of [...new Set(findings)]) console.error(`  ${finding}`);
  console.error(
    '\nRemove the value (and rotate the credential if it was ever committed or pushed). See docs/security.md.',
  );
  process.exit(1);
}
console.log(`check:secrets: no private files or credentials found in ${scope}.`);
