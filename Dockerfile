# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@10.30.0

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml ./
# Install inside Linux so optional native modules match the image, never the host.
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=4111 DATABASE_URL=file:/app/data/opensenpai.db
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4111
VOLUME ["/app/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4111/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--role", "all", "--transport", "http", "--port", "4111"]
