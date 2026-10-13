# Deployment

The agent is a single Node.js process with a SQLite database. It needs:
- **outbound HTTPS** to `api.telegram.org`, `api.x.com` and, with AI enabled, `api.openai.com`. It opens **no inbound port** (Telegram long polling).
- **about 150 MB of RAM** and a few MB of disk, plus your backups.
- **one instance per database.** A second instance waits for the first one's lease, then refuses to start.

All private state lives in `local/`: your config, profile, database and backups. Credentials live in `.env`.

## Docker Compose (recommended)

**On the server**, without Node.js installed:

```bash
git clone <your fork or this repository> x-personal-agent
```
```bash
cd x-personal-agent
```
```bash
cp .env.example .env && chmod 600 .env
```
```bash
mkdir -p local/data local/profile local/backups && chmod 700 local
```
```bash
cp config/agent.example.yaml local/agent.yaml
```
```bash
cp examples/profile/*.md local/profile/
```

Then:
1. Edit `.env`. Start with `PUBLISH_MODE=dry-run`.
2. Edit `local/agent.yaml`.
3. Rewrite every file in `local/profile/` and delete its `example-profile` line. Or set `ai.enabled: false`.

To find your Telegram user ID before the agent runs:

```bash
docker compose run --rm agent node scripts/telegram-whoami.ts
```

Start it with your user's IDs, so the files the container writes in `local/` stay yours:

```bash
AGENT_UID=$(id -u) AGENT_GID=$(id -g) docker compose up -d --build
```

Check that it runs:

```bash
docker compose ps
```
```bash
docker compose logs -f agent
```

`docker compose ps` shows `healthy` while the agent's 30-second loop is alive. Docker Compose does **not** restart an unhealthy container by itself: watch `docker compose ps`, or add an external monitor. A crash, by contrast, is restarted (`restart: unless-stopped`).

The container runs as a non-root user, with a read-only filesystem, no Linux capabilities and `no-new-privileges`. Only `./local` is writable. On shutdown it gets 40 seconds to let an in-flight publication record its outcome.

**Useful commands**, run while it's up:

```bash
docker compose exec agent node scripts/db-backup.ts
```
```bash
docker compose exec agent node scripts/schedule-preview.ts 7
```
```bash
docker compose exec agent node scripts/x-verify.ts
```

**Updating:**

```bash
docker compose exec agent node scripts/db-backup.ts
```
```bash
git pull
```
```bash
AGENT_UID=$(id -u) AGENT_GID=$(id -g) docker compose up -d --build
```

Database migrations are applied automatically at startup.

## systemd (without Docker)

Requires Node.js 24 and pnpm 10.

```bash
sudo useradd --system --create-home --home-dir /opt/x-personal-agent agent
```
```bash
sudo -u agent git clone <repository> /opt/x-personal-agent
```
```bash
cd /opt/x-personal-agent && sudo -u agent pnpm install --frozen-lockfile --prod
```
```bash
sudo -u agent node scripts/init-local.ts
```

Edit `.env`, `local/agent.yaml` and `local/profile/` as above. Use `LOG_FORMAT=json`: `pretty` needs the dev dependencies. Then install the unit from `deploy/systemd/x-personal-agent.service`; the file explains the steps.

```bash
journalctl -u x-personal-agent -f
```

Exit code `78` (invalid configuration) is not restarted, because restarting would not help. Fix the configuration and start the service again.

## Going live

See [Publishing to X](../README.md#publishing-to-x) in the README:
1. Run `pnpm x:verify`.
2. Set `PUBLISH_MODE=live`.
3. Restart.
4. Check that `/status` says "live".
5. Publish one test post of your choice.

Remember that dry-run "publications" consume queued posts. Start live with a fresh database, or queue your real posts after switching.
