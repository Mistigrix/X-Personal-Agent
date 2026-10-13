# Contributing

Contributions are welcome. By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).

## Setup

Node.js 24+ and pnpm 10.

```bash
pnpm install
```
```bash
pnpm init:local
```

The tests need no credentials and never touch the network: Telegram, X and OpenAI are replaced by recorders, fakes and local fake servers.

```bash
pnpm check
```

`pnpm check` runs type checking, Biome lint and format checks, and the Vitest suite. Run `pnpm format` to apply formatting.

## Rules that must not be weakened

These are the product's guarantees. Every change must keep them, with tests.

1. **An AI-generated post is published only with an approval of its exact current version** (version and SHA-256 of the text). The rule lives in `src/domain/publication-policy.ts` and must never become configurable.
2. **Personal posts are never rewritten.** The text is stored and sent byte-for-byte.
3. **An ambiguous publication outcome is never retried blindly.** The attempt is recorded before the request; uncertain outcomes are reconciled or decided by the user.
4. **Only allowlisted Telegram users, in private chats, can act.**
5. **No credential in logs, errors, fixtures or the repository.** Fake credentials in tests are assembled at runtime (see `tests/helpers/fixtures.ts`) so no credential-shaped literal exists in the source.

## Architecture

| Folder | Holds | Rules |
|---|---|---|
| `src/domain/` | Pure rules: post states and transitions, publication policy, scheduling, text analysis, editorial checks. | No I/O. |
| `src/services/` | Use cases and transactions. | No transaction is ever held open across a network call. |
| `src/integrations/` | Telegram, X and OpenAI adapters. | Translate HTTP into typed results; no business decisions, no automatic retries of side effects. |
| `src/db/` | Drizzle schema and repositories. | |

TypeScript runs natively on Node: keep to erasable syntax (no enums, namespaces or parameter properties) and import local files with their `.ts` extension.

## Database changes

1. Edit `src/db/schema.ts`.
2. Run `pnpm db:generate` and review the SQL in `drizzle/`.
3. Commit the schema and the generated migration together. Migrations run automatically at startup and must be additive.

## Prompts and examples

Prompt templates (`prompts/`) and the demo profile (`examples/profile/`) are public and generic. Never put real personal information in them. Every demo profile file keeps its `example-profile` marker.

## Before committing

```bash
pnpm check && pnpm check:secrets
```

Before publishing a fork or a release, also run `pnpm check:secrets --history`.
