# CLAUDE.md

Guidance for AI coding agents working in this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

A self-hosted agent that publishes the owner's posts on X and drafts AI posts for explicit approval, driven from a private Telegram bot. It is a single Node.js 24 process with SQLite (Drizzle). It talks to Telegram (grammY), X (official SDK `@xdevplatform/xdk`) and OpenAI (Responses API). Design and progress live in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Commands

```bash
pnpm check            # typecheck + Biome lint/format check + all tests (run before declaring work done)
pnpm test             # Vitest only; no network, no credentials needed
pnpm format           # apply Biome formatting and safe fixes
pnpm db:generate      # after editing src/db/schema.ts; commit the generated drizzle/ SQL
pnpm check:secrets    # before every commit (add --history before publishing)
pnpm start            # run the agent (needs .env and local/; see README)
```

## Non-negotiable rules

These are the product's guarantees. Never weaken them, never make them configurable, and keep their tests green.

1. **An AI-generated post is published only with an approval of its exact current version.**
   - The approval matches the version and the SHA-256 of the text.
   - The rule lives in `src/domain/publication-policy.ts`, checked inside the claim transaction.
   - A test asserts the config schema has no approval toggle.
2. **Personal posts are stored and sent byte-for-byte.** No trimming, no normalization, no AI rewriting.
3. **An ambiguous publication outcome is never retried blindly.**
   - The attempt is recorded before the HTTP call.
   - Timeouts, 5xx and duplicate-content errors make the post `uncertain`, and the reconciler checks the timeline.
   - Automatic retries happen only when X certainly did not receive the request.
4. **Only allowlisted Telegram user IDs in private chats can act** (`src/integrations/telegram/auth.ts`).
5. **No credential in logs, errors, fixtures or commits.**
   - The logger redacts by key and scrubs by value.
   - Test credentials are assembled at runtime (`tests/helpers/fixtures.ts`) so no credential-shaped literal exists.

## Safety when operating

- **Never publish a real post or make paid API calls without the user's explicit approval.** That covers X writes, `pnpm x:verify` and real OpenAI runs. Use `PUBLISH_MODE=dry-run`, the fakes, or the local fake servers.
- **Never read, print or commit `.env` or anything in `local/`** (private config, profile, database). To test the real process, use a scratch `DATABASE_PATH`/`APP_CONFIG_PATH` passed through the environment, never the user's database.
- **Only one process can poll the Telegram bot.** A running agent and `telegram:whoami` conflict (409).

## Architecture

| Layer | Holds | Rules |
|---|---|---|
| `src/domain/` | Pure rules: post states and the transition table (`post.ts`), publication policy, scheduling/slots, text weighting (`twitter-text`), editorial checks. | No I/O. |
| `src/services/` | Use cases: queue, scheduler, publisher, reconciler, review, editorial engine, daily drafts, stats, lease. | They own transactions. |
| `src/integrations/` | Adapters for Telegram (bot, views, callbacks), X (live + dry-run clients, error classifier) and OpenAI. | Translate I/O only: no business rules, no retries of side effects. |
| `src/db/` | Schema, client and repositories. | Repository functions take a `DbExecutor` (database or transaction). |
| `src/jobs/` | The 30-second ticker and the per-tick tasks. | All state is in the database, so restarts lose nothing. |
| `src/main.ts` | Composition root (manual dependency injection). | |
| `scripts/` | CLI tools. | They reuse `src/`. |

Rules of thumb:
- **Transactions** use `{ behavior: 'immediate' }`, are short and synchronous (better-sqlite3), and **never** span a network or model call.
- **Status changes** go through `assertTransition` and `updatePost(..., expectedStatus, ...)` (optimistic check).
- **Telegram handlers** parse and render only. Slow model work goes through `BackgroundTasks`: deduplicated by key, acknowledged before it starts, aborted on shutdown.
- **Button payloads** carry the post version (`a:ID:3`), so stale cards are refused.

## Code conventions

- **Node runs `.ts` directly (type stripping).** Erasable syntax only: no `enum`, `namespace` or constructor parameter properties. Import local files with the `.ts` extension. Use `import type` for types.
- **Strictness:** TypeScript strict with `noUncheckedIndexedAccess`.
- **Formatting:** Biome, with single quotes, semicolons, 2 spaces and a width of 100. Run `pnpm format` after edits.
- **Invisible or combining characters** (U+FFFE, U+0301, ZWJ…) are written as `\u` escapes or `String.fromCharCode` in source, never as literal characters.
- **Factories, not classes:** services are created by `createXxx(deps)` returning an interface. Results are discriminated unions (`{ kind: ... }`) rather than exceptions for expected outcomes.
- **Logging:** log public IDs (`postId: 'P7K2QX'`), never post text at info level and never secrets.

## Tests

- **No network.** Test doubles live in `tests/helpers/`:
  - `services.ts`: the full service graph on in-memory SQLite, with a controllable clock.
  - `fake-x.ts`: scriptable X client and recording notifier.
  - `fake-llm.ts`: scripted, schema-validated model answers.
  - `telegram.ts`: the real bot with the Bot API recorded.
  - `db.ts` and `ai.ts`: state setup and inspection helpers.
- **Contract tests** run the real SDK adapters against local fake HTTP servers: `tests/x-client.contract.test.ts` and `tests/openai-client.contract.test.ts`.
- **Background work:** await `services.background.idle()` before asserting on its results.
- **Time:** use the injected `TestClock`, never real timers. Slot times are random per database: make assertions independent of the exact minute.

## Changing things safely

| Change | Also do |
|---|---|
| New config key | Zod schema with a default (`src/config/app-config.ts`), `config/agent.example.yaml`, `docs/configuration.md`. |
| Schema change | `pnpm db:generate`, review the SQL, commit both. Migrations must be additive. |
| Prompt template | Placeholders must match the variables the editorial service passes (enforced by `src/services/editorial/prompts.test.ts`). Templates stay generic: no personal data. |
| Upgrade `@xdevplatform/xdk` | It is pinned exactly with `retry: false`. Upgrade only if the X contract test still passes unchanged. |
| New Telegram command | Add it to `BOT_COMMANDS` and the help text in `views.ts`. |
| User-facing behaviour | Update `README.md` or `docs/`, and the milestone log in `IMPLEMENTATION_PLAN.md`. |

The demo profile in `examples/profile/` is fictional. Every file keeps its `example-profile` marker, and the loader refuses a real profile that still contains it.
