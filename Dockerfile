# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@10.30.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/package.json
COPY apps/server/package.json ./apps/server/package.json

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
# TypeScript emits portable JavaScript; compile on the builder's native architecture.
WORKDIR /app
RUN npm install --global pnpm@10.30.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/package.json
COPY apps/server/package.json ./apps/server/package.json
# Build the standalone research server.
RUN pnpm install --frozen-lockfile --filter @opensenpai/server... --filter .
COPY tsconfig*.json turbo.json ./
COPY packages/core ./packages/core
COPY apps/server ./apps/server
RUN pnpm exec turbo run build --filter=@opensenpai/server...

FROM base AS production-dependencies
# Install inside Linux so optional native modules match the image, never the host.
RUN pnpm install --prod --frozen-lockfile --filter @opensenpai/server... --filter . && pnpm store prune

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4111 DATABASE_URL=file:/app/data/opensenpai.db
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/core ./packages/core
COPY --from=production-dependencies /app/apps/server ./apps/server
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY package.json ./
COPY opensenpai.config.mjs ./
COPY config ./config
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4111
VOLUME ["/app/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4111/ready',{headers:{authorization:'Bearer '+(process.env.INTERNAL_EXECUTION_TOKEN||'')}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "apps/server/dist/cli.js"]
CMD ["--role", "all", "--transport", "http", "--port", "4111"]
