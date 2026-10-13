# Operations

## Day to day

| Need | How |
|---|---|
| Is it running? | `/status` in Telegram, or `pnpm healthcheck` (exit code 0 = alive) |
| What will be published, when? | `/queue`, or `pnpm schedule:preview 7` |
| Activity and costs | `/stats`: publications, AI review decisions, OpenAI tokens, estimated X costs |
| Stop publishing for a while | `/pause`, then `/resume`. Posts that missed their time while paused move to new slots. |
| Remove a queued post | `/cancel ID` |
| AI drafts waiting | `/drafts` |

## Logs

Logs are JSON lines on stdout (`LOG_FORMAT=json`). They never contain credentials: these are redacted by field name and scrubbed by value. They don't contain post text at info level either; posts appear by their public ID, e.g. `"postId":"P7K2QX"`.

Useful events:
- `Publishing post` / `Publication attempt finished`: carries `outcome` and the X error `code`.
- `Uncertain publication confirmed on X` / `… not found on X`.
- `Daily drafts prepared`, `Editorial job failed`.
- `Another instance holds the publication lease`: normal for up to 95 seconds after a crash.

Use `LOG_LEVEL=debug` temporarily when investigating.

## Backups

```bash
pnpm db:backup
```

This writes `local/backups/agent-YYYYMMDD-HHMMSS.db` (or use `--dir`) and keeps the 14 most recent (`--keep`). Each backup is:
- **consistent**, even while the agent runs (SQLite online backup);
- **a single self-contained file**;
- **integrity-checked**, and readable only by its owner.

Schedule it, for example daily at 03:00, with Docker:

```cron
0 3 * * * cd /path/to/x-personal-agent && docker compose exec -T agent node scripts/db-backup.ts
```

The backups contain your unpublished drafts. Copy them off the server, but treat them as private.

## Restoring a backup

1. Stop the agent (`docker compose stop`, or `systemctl stop x-personal-agent`).
2. Move the current database aside: `local/data/agent.db`, plus `agent.db-wal` and `agent.db-shm` if present.
3. Copy the backup to `local/data/agent.db`. Make sure it's readable only by the agent's user (`chmod 600`).
4. Start the agent. Migrations are applied if the backup is older than the code.

Everything after the backup is lost from the agent's memory. Posts it published after the backup are still on X, and the agent no longer knows they were sent. **Pause first (`/pause`), check `/queue` against your X profile, and cancel anything already published before resuming.**

## Moving to another server

1. Stop the agent on the old server.
2. Copy `.env` and the whole `local/` directory.
3. Start the agent on the new server. Never run both at the same time with copies of the same database.

## Handling problem posts

| Situation | What the agent did | What you do |
|---|---|---|
| ❌ Failed (invalid text, credentials, credits) | Nothing was published. | Fix the cause, then **Publish again** or **Cancel** on the alert. |
| ⚠️ Uncertain (timeout, X server error, crash during publication) | Never resent. Looks for the post on your timeline for about 15 minutes. | Usually nothing: you get "Confirmed". If it asks: check your profile, then **Publish again**, **It is on X** or **Cancel**. |
| Missed slot (pause, downtime) | Moved to the next free slot. | Nothing. |
| AI draft regeneration failed | Shows the reasons and the current version again. | Edit it yourself, regenerate, or reject. |

## Upgrading

Back up first (`pnpm db:backup`), then pull and restart. Database migrations run automatically at startup and are additive. Read the release notes before upgrading across a major version.

## Credential rotation

See [security.md](security.md#rotating-credentials).
