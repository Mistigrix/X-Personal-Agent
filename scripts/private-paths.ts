/**
 * Paths that hold private data and must never be committed, whatever .gitignore
 * says. Used by `pnpm check:secrets` as a second line of defence.
 */
export function isPrivatePath(path: string): boolean {
  const name = path.split('/').at(-1) ?? path;
  return (
    path === 'local' ||
    path.startsWith('local/') ||
    (name.startsWith('.env') && name !== '.env.example') ||
    /\.(db|sqlite3?)(-.*)?$/.test(name) ||
    name.endsWith('.bak')
  );
}
