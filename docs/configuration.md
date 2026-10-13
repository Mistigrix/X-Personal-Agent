# Configuration reference

The agent reads three things at startup:
- **environment variables**, usually from `.env`;
- a **YAML behaviour file**, `local/agent.yaml` by default;
- your **editorial profile**, `local/profile/*.md`.

All of it is validated together. Any problem is reported with a suggested fix, and the agent exits with code `78` without starting anything.

Real environment variables take precedence over `.env`, so values set by Docker Compose or systemd win. Relative paths are resolved from the project root.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Token from @BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | yes | — | Comma-separated numeric Telegram user IDs allowed to use the bot (`pnpm telegram:whoami` prints yours). |
| `PUBLISH_MODE` | no | `dry-run` | `dry-run` simulates publications. `live` publishes on X and requires the four `X_*` variables. |
| `X_API_KEY`, `X_API_SECRET` | in live mode | — | Consumer key and secret of your X app. |
| `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | in live mode | — | OAuth 1.0a access token and secret for your account, generated **after** setting the app to "Read and write". |
| `OPENAI_API_KEY` | if `ai.enabled` | — | OpenAI API key. |
| `APP_CONFIG_PATH` | no | `./local/agent.yaml` | Behaviour file. |
| `DATABASE_PATH` | no | `./local/data/agent.db` | SQLite database. Use a different file for dry-run experiments. |
| `LOG_LEVEL` | no | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `LOG_FORMAT` | no | `json` | `json`, or `pretty` for humans (needs the dev dependencies). |
| `NODE_ENV` | no | `production` | `development`, `production` or `test`. |

The OpenAI SDK also honours `OPENAI_BASE_URL`, for a proxy or a compatible endpoint.

## Behaviour file (`local/agent.yaml`)

`config/agent.example.yaml` documents every key with an example. Unknown keys are rejected, so a typo cannot be silently ignored. Only `configVersion`, `timezone` and `ai.models` are required; everything else has a default.

There is deliberately **no setting that disables the approval of AI-generated posts**.

### General

| Key | Default | Description |
|---|---|---|
| `configVersion` | — (must be `1`) | Format version of this file. |
| `timezone` | — | IANA timezone (e.g. `Africa/Abidjan`). Used for windows, daily jobs and displayed times. Times are stored in UTC. |

### `schedule`

| Key | Default | Range | Description |
|---|---|---|---|
| `postsPerDay` | `3` | 1–12 | Daily target. Empty slots stay empty. Must not exceed the number of windows. |
| `activeDays` | all days | `mon`…`sun` | Days on which posts are published. |
| `windows` | 08:00–09:30, 12:30–14:00, 18:30–20:30 | `HH:mm` | Local-time windows, chronological, not overlapping. The first `postsPerDay` windows get one slot each per day, at a time that varies from day to day. |
| `minGapMinutes` | `90` | 0–720 | Minimum time between two posts. The windows must allow it. |
| `maxLatenessMinutes` | `30` | 1–1440 | A post overdue by more than this (pause, downtime) moves to the next free slot instead of being published late. |

### `publishing`

| Key | Default | Range | Description |
|---|---|---|---|
| `maxWeightedLength` | `280` | 1–25000 | Maximum length as counted by X. Premium accounts can post longer. |
| `urlPolicy` | `confirm` | `allow`, `confirm`, `block` | Posts with links cost more on the X API: no warning, warn and ask, or refuse. |
| `requestTimeoutSeconds` | `20` | 5–120 | Timeout of X API requests. A timeout makes the outcome uncertain, and it is never retried blindly. |
| `maxRetries` | `3` | 0–10 | Retries when X certainly did not receive or accept the request (connection refused, rate limit). |
| `retryBaseDelaySeconds` | `60` | 10–3600 | First retry delay, doubled each time (capped at 1 hour). Rate limits wait for X's reset time. |
| `reconcile.initialDelaySeconds` | `60` | 10–3600 | Wait before looking for an uncertain post on your timeline. |
| `reconcile.intervalSeconds` | `180` | 30–3600 | Time between timeline checks. |
| `reconcile.maxChecks` | `5` | 1–20 | Checks before declaring the post not found and asking you. |
| `reconcile.autoRetryIfNotFound` | `false` | | `true` reschedules automatically after "not found", except after a duplicate-content refusal. |

### `telegram`

| Key | Default | Description |
|---|---|---|
| `confirmPersonalPosts` | `true` | Show [Queue] / [Discard] before queuing a post you send. Posts with warnings (links, possible credentials) always ask. |
| `notifyOnStartup` | `true` | Message you when the agent starts. |

### `ai`

| Key | Default | Range | Description |
|---|---|---|---|
| `enabled` | `true` | | `false` for personal posts only (no OpenAI key or profile needed). |
| `models.ideas`, `models.drafting`, `models.evaluation` | — (required) | | OpenAI model ID for each task. |
| `reasoningEffort` | `medium` | `none` … `max` | Passed to the model; support depends on the model. |
| `requestTimeoutSeconds` | `120` | 10–600 | Timeout of a model request (the SDK retries twice). |
| `ideasPerRequest` | `5` | 1–10 | Default number of ideas for `/ideas`. |
| `maxRegenerations` | `2` | 0–5 | Automatic revisions when a draft fails the checks. |
| `autoGenerate.enabled` | `true` | | Prepare drafts once a day. |
| `autoGenerate.at` | `07:00` | `HH:mm` | Local time after which the daily drafts are prepared. |
| `autoGenerate.maxPendingDrafts` | `3` | 1–20 | Never more drafts than this waiting for your review. |

### `editorial`

| Key | Default | Description |
|---|---|---|
| `languages.default` | `en` | ISO 639-1 code. Must be in `allowed`. |
| `languages.allowed` | `[en]` | Languages posts may be written in (one language per post, no translations). |
| `languages.guidance` | empty | Plain-language rule for choosing the language of each post. |
| `contentMix` | 4 equal categories | Relative weights of categories (any lowercase names). Ideas favour under-represented ones. |
| `topics.focus`, `topics.avoid` | empty | Topics to favour, and topics to avoid (drafts mentioning them get a warning). |
| `bannedPhrases` | empty | Phrases AI drafts must never contain (case- and apostrophe-insensitive). |
| `hashtags.max`, `emojis.max` | `1`, `2` | Limits for AI drafts. |
| `checks.lookbackPosts` | `50` | Recent posts compared against new drafts. |
| `checks.nearDuplicateThreshold` | `0.8` | Similarity (0.5–1) above which a draft counts as a near-duplicate. |
| `checks.topicCooldownDays` | `3` | Days before an idea on the same topic is accepted again. |

### `costs`

Used only for the estimates shown by `/stats`; this is not billing data.

| Key | Default | Description |
|---|---|---|
| `xPostUsd` | `0.015` | X API price of a post, in USD. |
| `xPostWithUrlUsd` | `0.20` | X API price of a post containing a link. |

### `paths`

| Key | Default | Description |
|---|---|---|
| `profileDir` | `./local/profile` | Your editorial profile. Point it at `./examples/profile` to try the fictional demo persona. |
| `promptsDir` | `./prompts` | Default prompt templates. |
| `promptOverridesDir` | `./local/prompts` | A template placed here replaces the default one with the same name. |

## Editorial profile (`local/profile/`)

| File | Required | Content |
|---|---|---|
| `identity.md` | yes | Who you are professionally. |
| `voice.md` | yes | Tone, style, vocabulary, things you never write. |
| `facts.md` | yes | Verified facts the AI may state about you. Nothing else will be claimed. |
| `opinions.md` | yes | Opinions you actually hold. Nothing else is presented as your opinion. |
| `projects.md` | no | Current projects, and what may or may not be shared. |
| `examples.md` | no | Posts you wrote, separated by lines containing only `---`. Used as style references, never copied. |
| `rules.md` | no | Editorial rules in plain language. |

HTML comments (`<!-- -->`) are guidance for you and are never sent to the model. A file that still contains the `example-profile` marker is refused, so the fictional demo is never used as you by accident. The profile is read at startup: restart after editing it.

## Prompt templates (`prompts/`)

Three Markdown templates with `{{placeholders}}`:
- `generate-ideas.md`
- `generate-post.md`
- `evaluate-post.md`

Each file's header comment lists the placeholders it may use. Rendering fails if a placeholder has no value. To customise one, copy it to `local/prompts/` and edit the copy. Edits apply without a restart, and the hash of the template used is stored with every draft.
