# Deployment

Node 24 LTS and pnpm 10.30.0 are the supported build toolchain. Turborepo builds `apps/server` and its `packages/core` dependency for the Docker image; `apps/cloudflare` contains the ingress and queue adapter. One image contains the CLI, native Mastra MCP server, storage, and workflow runtime. Secrets are supplied at runtime; the Dockerfile copies only manifests, source, and compiled output.

## Standalone Docker

Create your ignored `.env` from the root example and set `MCP_AUTH_TOKEN`, target configuration, and provider credentials. Local mock targets work without paid API credentials.

```sh
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:4111/ready
```

The app runs `--role all --transport http` and stores libSQL in the `app-data` volume at `/app/data/opensenpai.db`. `/mcp` requires `Authorization: Bearer <MCP_AUTH_TOKEN>`. Host port 4111 binds only to loopback. `/health` checks process liveness; `/ready` checks application readiness. The image runs as the unprivileged `node` user. Stop with `docker compose down`; named volumes persist until explicitly removed.

Use `DATABASE_URL` and optional `DATABASE_AUTH_TOKEN` to select remote libSQL instead. The file path must be writable by uid 1000 when replacing the named volume with a bind mount.

## Split API and worker

```sh
docker compose -f compose.split.yaml --profile split --profile database up --build -d
docker compose -f compose.split.yaml --profile split --profile database ps
```

This starts separate API and worker processes, private libSQL, and Valkey 8 with append-only persistence. API and worker share the database and stream. The worker executes native Mastra workflow steps inside its own process. It has a private readiness endpoint and no host port. No `MASTRA_STEP_EXECUTION_URL` is used.

To use managed libSQL/Turso, supply `DATABASE_URL` and `DATABASE_AUTH_TOKEN`, and omit `--profile database`:

```sh
docker compose -f compose.split.yaml --profile split up --build -d
```

Both processes must share `WORKSPACE_ID` and target configuration. Back up the database volume or remote service independently of container images. The split profile is intended for trusted private networks; database and Valkey ports are not published.

## Cloudflare compute

All application compute runs on Cloudflare: a Worker provides ingress and consumes Queues, while a Cloudflare Container runs the same native Node/Mastra application image. Persisted state lives in remote libSQL/Turso. No application state depends on the container filesystem. This profile needs a Cloudflare account with Workers, Queues, and Containers enabled.

The installed `@mastra/mcp` 2.4.1 API exposes `startHTTP({req,res})` with Node `IncomingMessage` and `ServerResponse`; the package calls its Node HTTP handler. This compatibility gate selects Containers instead of substituting a hand-written MCP implementation in Workers. The Worker imports only Cloudflare's Containers adapter and deployment handlers. Native MCP, the provider adapters, and Mastra stay inside the Linux image.

Cloudflare's [Container class](https://developers.cloudflare.com/containers/api/container-class/) supplies lifecycle management and runtime environment forwarding. Queue delivery is at least once; the [retry and dead-letter configuration](https://developers.cloudflare.com/queues/configuration/batching-retries/) retains failed deliveries after bounded retries.

Run local build checks from the repository root:

```sh
pnpm --filter @opensenpai/cloudflare typecheck
pnpm test tests/deployment.test.ts
pnpm exec wrangler deploy --dry-run --containers-rollout none --config apps/cloudflare/wrangler.json
docker build --platform linux/amd64 -t opensenpai:cloudflare .
```

The `--containers-rollout none` command verifies the Worker bundle and configuration without building an image or accessing an account. A complete `wrangler deploy --dry-run --config apps/cloudflare/wrangler.json` also builds the configured Linux image. CI runs the complete dry run and Docker build. Neither command publishes the Worker.

Create the queues and supply runtime secrets before deploying:

```sh
pnpm exec wrangler login
pnpm exec wrangler queues create opensenpai-observations
pnpm exec wrangler queues create opensenpai-observations-dlq
pnpm exec wrangler secret put DATABASE_URL --config apps/cloudflare/wrangler.json
pnpm exec wrangler secret put DATABASE_AUTH_TOKEN --config apps/cloudflare/wrangler.json
pnpm exec wrangler secret put MCP_AUTH_TOKEN --config apps/cloudflare/wrangler.json
pnpm exec wrangler secret put INTERNAL_EXECUTION_TOKEN --config apps/cloudflare/wrangler.json
pnpm exec wrangler secret put TARGETS_JSON --config apps/cloudflare/wrangler.json
```

Use independent random tokens for MCP and internal execution. Add each provider credential referenced by the targets with `wrangler secret put <ENV_NAME> --config apps/cloudflare/wrangler.json`. String environment bindings are forwarded to the container at startup; queue and Durable Object service bindings are not forwarded. Set `WORKSPACE_ID` in `apps/cloudflare/wrangler.json`. `DATABASE_URL` must begin with `libsql://`, `https://`, or `http://`; local files are rejected on Cloudflare.

Deploy when the account and runtime configuration are ready:

```sh
pnpm exec wrangler deploy --config apps/cloudflare/wrangler.json
```

The Worker exposes `/mcp`, `/health`, and `/ready`. Internal observation endpoints are inaccessible through ingress. A single named container and one queue consumer limit application concurrency. Provider execution occurs only inside an awaited authenticated queue request, using the shared bounded observation workflow; generic detached Mastra workers and automatic research scheduling are disabled in this profile.

An accepted observation is persisted before dispatch. The Worker sends only `{ "observationId": "..." }` to the queue, then marks it queued in libSQL. If sending succeeds but marking fails, a duplicate is safe because execution uses a durable compare-and-set claim. A minute Cron repairs dispatch for existing accepted observations; it does not create research runs. Each queue handler waits for terminal persistence before acknowledging. Nonterminal, timeout, network, and malformed-message failures retry. `max_batch_size=1`, `max_concurrency=1`, and three retries are configured; exhausted messages go to `opensenpai-observations-dlq`. Inspect the DLQ in the Cloudflare dashboard and diagnose the durable observation before replaying its ID. Replaying an already terminal observation does not execute another paid call.

The container may sleep after five idle minutes; remote libSQL preserves state across restarts. Cold starts can delay readiness. No live Cloudflare deployment or paid provider call is part of the local compatibility tests.
