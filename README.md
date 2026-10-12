# x-personal-agent

A self-hosted agent that keeps your X (Twitter) account active without making it inauthentic:

- **Your own posts**: send them to a private Telegram bot. They are queued verbatim and published automatically at good times through the official X API.
- **AI-assisted posts**: the agent drafts posts from *your* editorial profile (facts, opinions, voice) with the OpenAI API, and sends them to Telegram for review. **Nothing AI-generated is published without your explicit approval of its exact text.**

It runs as a single Node.js process with a SQLite database. You configure it entirely through local files, without modifying source code.

> **Status: early development.** Milestones 1–3 of 6 are done: configuration, the Telegram bot and personal-post queue, and publication to X with retries, uncertain-outcome reconciliation and a dry-run mode. AI-generated drafts are not implemented yet. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the roadmap.

## Safety model

These rules are enforced in code. No configuration setting can disable them:

- An AI-generated post can only be published if you approved **its current version**. Any edit or regeneration invalidates the approval.
- Your personal posts are never rewritten.
- Only the Telegram user IDs you allow, in private chats, can control the bot.
- `PUBLISH_MODE` defaults to `dry-run`: nothing is sent to X until you explicitly switch to `live`.
- Credentials are never logged. They are redacted by field name and scrubbed by value from every log line.
- The fictional example profile is never used as yours. The agent refuses to start if your profile still contains example content.

## Requirements

- Node.js 24 or later. TypeScript runs natively; there is no build step.
- pnpm 10 (`npm install -g pnpm`)
- git

## Quick start

```bash
pnpm install
pnpm init:local
```

`init:local` creates your private, gitignored setup from the committed examples, without overwriting anything:

| Created | From | Purpose |
|---|---|---|
| `.env` | `.env.example` | Secrets and deployment settings |
| `local/agent.yaml` | `config/agent.example.yaml` | Behaviour: schedule, AI models, editorial rules |
| `local/profile/*.md` | `examples/profile/` | Your editorial profile (rewrite it!) |

Then:

1. Set up the Telegram bot (see [Telegram setup](#telegram-setup)) and fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` in `.env`. Add `OPENAI_API_KEY` if AI is enabled.
2. Review `local/agent.yaml`.
3. Rewrite each file in `local/profile/` with your own information and delete its `example-profile` line. Alternatively, set `ai.enabled: false` to use personal posts only.
4. Run `pnpm start`.

To try the agent with the fictional demo persona, set `paths.profileDir: ./examples/profile` in `local/agent.yaml`.

## Telegram setup

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and follow the steps. Copy the token into `TELEGRAM_BOT_TOKEN` in `.env`.
2. Find your numeric user ID: run `pnpm telegram:whoami`, then send any message to your bot. Your ID is printed **in the terminal** (the bot never replies). Press Ctrl+C.
3. Put the ID in `TELEGRAM_ALLOWED_USER_IDS`. Separate several IDs with commas.
4. Run `pnpm start` and open a private chat with your bot.

Only allowlisted users in private chats are answered. Everyone else is ignored without a reply. Only one process can receive the bot's updates at a time, so stop the agent before running `telegram:whoami`.

## Using the bot

**Submitting a post:** send any text message. The bot replies with a preview:
- the exact text and its length as counted by X
- warnings, if any (links, possible credentials)
- the publication time it would get

Tap **✅ Queue** to queue it or **🗑 Discard** to drop it. The text is stored exactly as you sent it, with no rewriting or trimming. Tapping a button twice has no extra effect.

**Scheduling:**
- Each day has up to `schedule.postsPerDay` slots, one inside each of the first windows.
- The time within a window varies from day to day, and posts are always at least `minGapMinutes` apart.
- Posts take the earliest free slot, in order.
- Empty slots stay empty: nothing is invented to fill them.

| Command | Description |
|---|---|
| `/queue` | List queued posts with their IDs and publication times |
| `/cancel ID` | Cancel a queued post (frees its slot) |
| `/status` | Mode (dry run or live), pause state, counts, next publication |
| `/pause`, `/resume` | Pause or resume automatic publication |
| `/add` | How to submit a post |
| `/help` | List commands |

To change a queued post, `/cancel` it and send the corrected text. Edits to messages already sent are not applied.

**Publication:**
- Every 30 seconds the agent publishes the next due post, if publication is not paused.
- Posts that missed their time by more than `schedule.maxLatenessMinutes` (after a pause or downtime) move to the next free slots instead of going out in a burst.
- You get a message for each outcome:

| Outcome | What happens |
|---|---|
| ✅ Published | Includes a link to the post. In dry run, the message says nothing was sent. |
| Temporary error (X unreachable, rate limit) | Retried automatically with increasing delays (`publishing.maxRetries`), silently. |
| ❌ Failed (invalid text, credentials, credits) | Not retried. Buttons: **Publish again**, **Cancel**. |
| ⚠️ Uncertain (timeout, X server error, interrupted shutdown) | Never resent automatically. The agent looks for the post on your timeline. If found, it confirms. If not, it asks you: **Publish again**, **It is on X**, **Cancel**. |

## Publishing to X

### Dry run first

With `PUBLISH_MODE=dry-run` (the default), the full flow runs but nothing is sent to X: posts are marked as published and the notification is labelled **[DRY RUN]**.

> ⚠️ A dry-run "publication" consumes the queued post: it will not be published again in live mode. Use a separate database for experiments (for example `DATABASE_PATH=./local/data/dry-run.db`), and queue your real posts once you are in live mode.

`pnpm schedule:preview [days]` lists the upcoming publication times and which post takes each one.

### X developer setup

1. In the [X Developer Console](https://developer.x.com), create a project and an app.
2. In the app's user authentication settings, set the permissions to **Read and write**.
3. In **Keys and tokens**, copy the API key and secret, then generate the access token and secret **for your own account**. Generate them **after** setting Read and write: tokens created before keep read-only access.
4. Buy credits and set a **spending cap** (see [X API costs](#x-api-costs)).
5. Put the four values in `.env` (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`).
6. Run `pnpm x:verify`. It makes one paid request (`GET /2/users/me`, about $0.01) and prints the account it authenticated as.

### Going live

1. Stop the agent.
2. Set `PUBLISH_MODE=live` in `.env`. Point `DATABASE_PATH` at the database you want to use in production.
3. Start the agent. It checks the credentials at startup and refuses to start if X rejects them.
4. `/status` should show **Mode: live**. Send a test post, queue it, and check it on your profile once the notification arrives.

### Reliability and its limits

The X API has no idempotency key. If a request times out, the post may or may not have been created, and resending blindly could publish it twice. The agent therefore:

- records each attempt in the database **before** sending it, and never holds a database transaction open during the network call;
- retries only when the request certainly did not reach X (connection refused, DNS failure, rate limit);
- marks every ambiguous outcome as **uncertain** and never resends it automatically. It reads your recent posts (an owned read, $0.001 per post) to resolve it, then asks you if the post is not found. Automatic retry after "not found" can be enabled with `publishing.reconcile.autoRetryIfNotFound`;
- after a crash, recovers interrupted attempts as uncertain instead of resending them;
- runs only one instance per database: a lease renewed every 30 seconds, plus Telegram's own single-poller rule.

The guarantee is therefore **at most one automatic send per post version**, with a human decision for any outcome that cannot be confirmed. Exactly-once delivery is not possible with this API.

## Configuration

| Layer | File (gitignored) | Committed template | Contains |
|---|---|---|---|
| Secrets & deployment | `.env` | `.env.example` | Tokens and keys, allowed Telegram IDs, publish mode, paths, log settings |
| Behaviour | `local/agent.yaml` | `config/agent.example.yaml` | Timezone, posts per day, publication windows, retries, AI models, languages, content mix, banned phrases, check thresholds |
| Editorial profile | `local/profile/*.md` | `examples/profile/*.md` | Who you are and how you write (see below) |
| Prompt templates | `local/prompts/*.md` (optional overrides) | `prompts/*.md` | Generic instructions with `{{placeholders}}` |

Variables set in the real environment, for example by Docker or systemd, take precedence over `.env`.

At startup, the agent validates everything together. If anything is wrong, it lists **every** problem with a suggested fix, exits with code `78`, and starts nothing:

```
Configuration is invalid (2 problems). The agent did not start.

.env
  - TELEGRAM_BOT_TOKEN: is required
    Fix: Create a bot by messaging @BotFather on Telegram (/newbot) and paste the token it gives you.

local/agent.yaml
  - schedule.postPerDay: is not a recognized setting (check for a typo or wrong indentation)
```

### Editorial profile

The AI may only state what these files contain. It never invents experiences, numbers or opinions.

| File | Required | Content |
|---|---|---|
| `identity.md` | yes | Who you are professionally |
| `voice.md` | yes | Tone, style, vocabulary, things you never write |
| `facts.md` | yes | Verified facts the AI may state about you |
| `opinions.md` | yes | Opinions you actually hold |
| `projects.md` | no | Current projects, and what may or may not be shared |
| `examples.md` | no | Posts you wrote, used as style references (separated by `---`) |
| `rules.md` | no | Editorial rules in plain language |

HTML comments (`<!-- ... -->`) in these files are guidance for you and are not sent to the AI.

## Scripts

| Command | Description |
|---|---|
| `pnpm start` | Start the agent |
| `pnpm dev` | Start with auto-restart on file changes |
| `pnpm check` | Type-check, lint and test |
| `pnpm test` | Run the test suite (no network access needed) |
| `pnpm format` | Format and auto-fix with Biome |
| `pnpm init:local` | Create the private local setup from the examples |
| `pnpm db:migrate` | Apply database migrations (also done automatically at startup) |
| `pnpm db:generate` | Generate a migration after changing `src/db/schema.ts` |
| `pnpm check:secrets` | Scan committable files for private files and credentials |
| `pnpm telegram:whoami` | Print the Telegram user ID of whoever messages the bot |
| `pnpm schedule:preview [days]` | Show upcoming publication times and the posts assigned to them |
| `pnpm x:verify` | Check the X credentials (one paid request, about $0.01) |

## Project structure

```
src/
  config/       environment, YAML config and profile loading + validation
  domain/       business rules, pure and without I/O: post states, slots, text analysis
  db/           Drizzle schema, SQLite client, repositories
  services/     use cases: queue, scheduler, publisher, reconciler, notifications, instance lease
  jobs/         the 30-second ticker and the work done on each tick
  integrations/ external systems: Telegram bot, X API (official SDK, dry-run client)
  shared/       logging, secret redaction, clock, IDs, process helpers
  main.ts       composition root
drizzle/        generated SQL migrations
prompts/        generic prompt templates
config/         example behaviour config
examples/       fictional demo editorial profile
scripts/        setup and maintenance scripts
tests/          integration tests and fixtures
local/          your private data (gitignored)
```

## Security

**Never committed:** `.env`, everything in `local/` (config, profile, database, backups), any `*.db`/`*.sqlite` file, and logs. The `.gitignore` covers these. Run `pnpm check:secrets` before every commit as a second line of defence. It scans every committable file for private paths, credential patterns and the actual values from your `.env`.

**If a credential is exposed** (committed, pasted, logged), revoke it first. Rewriting git history does not help once something has been pushed or cloned.

| Credential | How to rotate |
|---|---|
| Telegram bot token | In @BotFather: `/revoke`, select the bot, then put the new token in `.env` |
| OpenAI API key | OpenAI dashboard > API keys: revoke the key, create a new one |
| X API key/secret, access token/secret | X Developer Console > your app > Keys and tokens: regenerate, then update `.env` |

Then restart the agent.

**Data sent to third parties:**
- OpenAI receives your editorial profile and drafts when generating posts.
- X receives the posts you publish.
- Telegram carries your conversations with the bot.

## X API costs

The X API is pay-per-use. Prices as of October 2026 ([official pricing](https://docs.x.com/x-api/getting-started/pricing)):

| Item | Price |
|---|---|
| Plain post | $0.015 |
| Post containing a URL | $0.20 |
| Reading back your own posts (used to verify uncertain publications) | $0.001 per post |

Three plain posts a day cost about $1.35/month. By default the agent warns you before queuing a post that contains a link (`publishing.urlPolicy`). Set a spending cap in the X Developer Console.

## License

Not chosen yet. A license will be added before the first public release.
