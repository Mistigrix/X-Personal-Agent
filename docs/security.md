# Security

## What the agent protects

- **Your X account.**
  - Only allowlisted Telegram users, in private chats, can act. Everyone else is ignored without a reply.
  - AI-generated posts are published only after an explicit approval of their exact text: the approval stores the version, a SHA-256 of the text, and who approved.
  - Any change voids the approval. This is enforced at publication time, in code, with no configuration switch.
- **Your credentials.**
  - They are read from the environment only.
  - Never logged: redacted by field name and scrubbed by value from every log line, error messages included.
  - Never shown in configuration errors.
- **Your unpublished content.**
  - It stays in `local/`: the SQLite database and backups, with owner-only file permissions.
  - Post text is not written to logs at info level.

## Data sent to third parties

| Service | Receives |
|---|---|
| Telegram | Your conversations with the bot (post texts, drafts, notifications). |
| X | The posts you publish; for uncertain publications, a read of your own recent posts. |
| OpenAI (if AI is enabled) | Your editorial profile (without `<!-- -->` comments), recent idea topics, drafts being written and reviewed. Requests use `store: false`. OpenAI's data retention policies still apply. |

## Keeping secrets out of git

- **What git ignores:** `.env`, `local/` (config, profile, database, backups), databases and logs (see `.gitignore`).
- **Before every commit:** run `pnpm check:secrets`. It scans committable files for private paths, credential patterns and the actual values from your `.env`.
- **Before publishing the repository:** run `pnpm check:secrets --history`. It scans every version of every file in the git history: a secret deleted in a later commit is still public once pushed.
- **Commit metadata is public too.** Check the author name and email of your commits; use your Git host's no-reply address if you prefer.

## Rotating credentials

Rotate **first** if a credential may have been exposed (committed, pasted, logged, shared). Cleaning the git history is a second step that does not undo exposure.

| Credential | Rotate | Then |
|---|---|---|
| Telegram bot token | In @BotFather: `/revoke`, choose the bot, copy the new token. | Update `TELEGRAM_BOT_TOKEN`, restart. |
| OpenAI API key | OpenAI dashboard → API keys: revoke the key, create a new one. | Update `OPENAI_API_KEY`, restart. |
| X API key and secret | X Developer Console → your app → Keys and tokens → regenerate. | Update `X_API_KEY` and `X_API_SECRET`. The access token must usually be regenerated too. |
| X access token and secret | Same page → regenerate the access token and secret (app set to Read and write). | Update `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET`, run `pnpm x:verify`, restart. |

If a secret was pushed to a public repository, also remove it from history (for example with `git filter-repo`) and force-push. Treat the old value as compromised regardless.

## Impact of a leaked credential

| Leaked | An attacker could | They could not |
|---|---|---|
| Telegram bot token | Read messages sent to the bot from then on, and send messages as the bot. | Approve or queue posts: the bot's handlers only act for allowlisted user IDs. |
| X credentials | Post as you. | Anything through this agent. Rotate immediately. |
| OpenAI key | Spend your OpenAI credits. | Access your other data. |
| `local/` contents | Read your profile, drafts and post history. | Anything else: the credentials are in `.env`, not `local/`. |

## Deployment hardening

- **Docker image:** runs as a non-root user, with a read-only filesystem, no capabilities and `no-new-privileges`. Only `local/` is writable.
- **systemd unit:** `ProtectSystem=strict`, with only `local/` writable.
- **Network:** no inbound port.
- **Supply chain:** dependencies are pinned in `pnpm-lock.yaml`. Install scripts are disabled except for `better-sqlite3` (native binding) and `esbuild` (development tool). Packages published less than 24 hours ago are refused (`pnpm-workspace.yaml`).

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
