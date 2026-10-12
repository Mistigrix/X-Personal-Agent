# x-personal-agent

A self-hosted agent that keeps your X (Twitter) account active without making it inauthentic:

- **Your own posts**: send them to a private Telegram bot. They are queued verbatim and published automatically at good times through the official X API.
- **AI-assisted posts**: the agent drafts posts from *your* editorial profile (facts, opinions, voice) with the OpenAI API, and sends them to Telegram for review. **Nothing AI-generated is published without your explicit approval of its exact text.**

It runs as a single Node.js process with a SQLite database. You configure it entirely through local files, without modifying source code.

> **Status: early development.** Milestone 1 of 6 is done: configuration, validation, database schema and logging. The Telegram bot, scheduling and publication are not implemented yet. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the architecture and roadmap.

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

1. Fill in `.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, and `OPENAI_API_KEY` if AI is enabled.
2. Review `local/agent.yaml`.
3. Rewrite each file in `local/profile/` with your own information and delete its `example-profile` line. Alternatively, set `ai.enabled: false` to use personal posts only.
4. Run `pnpm start`.

To try the agent with the fictional demo persona, set `paths.profileDir: ./examples/profile` in `local/agent.yaml`.

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

## Project structure

```
src/
  config/       environment, YAML config and profile loading + validation
  domain/       business vocabulary and rules (pure, no I/O)
  db/           Drizzle schema and SQLite client
  shared/       logging, secret redaction, process helpers
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
