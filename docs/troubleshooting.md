# Troubleshooting

Start with the agent's own message: configuration problems are listed with a "Fix:" line, and runtime problems appear in the logs and as Telegram alerts.

## Startup

| Symptom | Cause | Fix |
|---|---|---|
| `Configuration is invalid (N problems)`, exit code 78 | Missing or invalid settings. | Apply each "Fix:" line. See [configuration.md](configuration.md). |
| `… still contains the fictional example content` | A profile file was copied from the demo and not rewritten. | Rewrite it with your information and delete its `example-profile` line. Or set `ai.enabled: false`. |
| `Telegram rejected TELEGRAM_BOT_TOKEN (401)` | Wrong or revoked token. | Copy the token again from @BotFather. |
| `Another process is already receiving updates for this bot (409)` | Another agent instance, or `telegram:whoami`, is polling the bot. | Stop the other process. Only one can receive the bot's updates. |
| `Another instance holds the publication lease … waiting` | Normal for up to 95 s after a crash: the old lease must expire. | Wait. If it ends with "Another agent instance is running", stop that instance. |
| `X rejected the credentials (401)` (live mode) | Wrong X keys, or tokens generated before "Read and write" was set. | Set the app permissions to Read and write, regenerate the access token and secret, then run `pnpm x:verify`. |
| `"pretty" needs the pino-pretty dev dependency` | `LOG_FORMAT=pretty` in a production install. | Use `LOG_FORMAT=json`. |
| `SQLITE_CANTOPEN` / permission denied on `local/` (Docker, Dokploy) | The container user (UID 1000 in the image) cannot write the mounted directory. | Start with `AGENT_UID=$(id -u) AGENT_GID=$(id -g) docker compose up -d`, or fix the ownership of `local/`. |

## Telegram

| Symptom | Cause | Fix |
|---|---|---|
| The bot never answers | Your ID is not in `TELEGRAM_ALLOWED_USER_IDS`, or you wrote in a group. Unauthorized updates are ignored silently. | Check the logs for `Ignored Telegram update from an unauthorized user`, then add your ID (`pnpm telegram:whoami`). |
| "This card is outdated" | The post changed after the card was sent (edit, regeneration, decision). | Use the newest card, or `/drafts`. |
| No notification after a publication | Telegram was unreachable. | Notifications are retried every few minutes; nothing to do. |
| `/ideas` says AI drafting is disabled | `ai.enabled: false`, or `OPENAI_API_KEY` missing. | Set both, then restart. |

## Publication

| Symptom | Cause | Fix |
|---|---|---|
| Nothing published | Paused, dry run, nothing scheduled, or all slots in the future. | Check `/status` (mode, pause, next publication) and `pnpm schedule:preview`. |
| `X API credits or billing problem (402)` | No credits left. | Add credits in the X Developer Console, then **Publish again** on the alert. |
| `X refused the request (403)` | Missing write permission, a restricted account, or a restricted action. | Check the app permissions and the account; then retry or cancel. |
| `X rate limit reached` | Too many requests. | Nothing: the post waits for the reset time automatically. |
| A post is "uncertain" | Timeout, X server error or interrupted shutdown. | Wait for the timeline check. If it is not found, check your profile and decide. |
| Posts with links cost more than expected | X charges more for posts containing links. | `publishing.urlPolicy: confirm` or `block`. |

## AI drafts

| Symptom | Cause | Fix |
|---|---|---|
| `OpenAI rejected the API key (401)` | Wrong or revoked key. | Update `OPENAI_API_KEY` and restart. |
| `The model … does not exist` | A model ID in `ai.models` is not available to your account. | Use a model your account can access. |
| `OpenAI rate limit or quota reached` | Usage limits or billing. | Check your OpenAI account; the daily job runs again the next day. |
| "No draft passed the checks" | Every attempt broke a rule (length, banned phrase, unsupported claim…). | Read the listed reasons; adjust the profile, the rules or `ai.maxRegenerations`. |
| Drafts sound wrong or claim things | The profile is too thin or ambiguous. | Add facts and opinions to the profile, add example posts, then restart. |
