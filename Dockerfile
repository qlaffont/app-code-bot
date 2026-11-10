FROM oven/bun:1.3.10-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY prompts ./prompts
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV DB_PATH=/data/app-code-bot.sqlite
CMD ["bun", "run", "src/index.ts"]
