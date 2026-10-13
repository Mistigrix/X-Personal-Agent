# syntax=docker/dockerfile:1
# x-personal-agent: single Node.js process; config, profile and SQLite database under /app/local.

# The full image already ships python3, make and g++, needed if better-sqlite3 has
# no prebuilt binary for the platform. None of it reaches the final image.
FROM node:24-bookworm AS dependencies
WORKDIR /app
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    LOG_FORMAT=json
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY prompts ./prompts
COPY config ./config
COPY examples ./examples
# Your config, profile, database and backups live in /app/local (mounted at run
# time). The directories exist and belong to `node` so that an empty named volume
# mounted on them (Docker, Dokploy, Swarm) inherits that ownership and is writable.
RUN mkdir -p /app/local/data /app/local/backups /app/local/profile /app/local/prompts \
  && chown -R node:node /app/local
USER node
# Healthy while the agent renews its lease (every 30 seconds).
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD ["node", "scripts/healthcheck.ts"]
CMD ["node", "src/main.ts"]
