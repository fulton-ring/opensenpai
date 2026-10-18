# Deployment

Node 24 LTS and pnpm 10.30.0 are the supported build toolchain. Turborepo builds `apps/server` and `packages/core` for the Docker image; `apps/cloudflare` contains ingress and queue adapters. These public deployments run the research service with operator-supplied provider credentials. The managed service, including its account/payment APIs and web frontend, lives in the private repository `../opensenpai-web` and deploys independently. Public builds, Docker images, and Worker bundles have no private package or frontend artifact dependency. One image contains the CLI, native Mastra MCP server, storage, and workflow runtime. Secrets are supplied at runtime; the Dockerfile copies only manifests, source, and compiled output.

The TypeScript build runs on the builder's native architecture. Production dependencies are installed for the image's target architecture, so Cloudflare's Linux AMD64 runtime receives matching native libSQL modules without emulating the TypeScript compiler on Apple Silicon.

## Published images

GitHub Actions publishes `ghcr.io/fulton-ring/opensenpai` after the full checks succeed. Main publishes `latest` and `sha-<full-commit>`; a tag such as `v1.2.3` publishes `1.2.3`, `1.2`, and its commit tag. `latest` follows main, not older release tags. Images support Linux AMD64 and ARM64 and include BuildKit provenance and an SBOM. The image digest appears in the workflow summary; pin a digest for reproducible production deployment.

```sh
docker pull ghcr.io/fulton-ring/opensenpai:latest
docker run --rm --env-file .env -p 127.0.0.1:4111:4111 -v opensenpai-data:/app/data ghcr.io/fulton-ring/opensenpai:latest
```

The workflow authenticates with the repository's built-in `GITHUB_TOKEN` and grants package write access only to the publisher job. No provider, Clerk, Stripe, or Cloudflare secrets are needed to build or publish. Pull requests and scheduled checks never publish. New GHCR packages initially default to private; after the first publication, set this engine package to Public in package settings to allow anonymous pulls. The managed-service image is built and published separately by the private `opensenpai-web` repository and must remain Private. Repository/package permissions and organization policy must allow Actions publication.

## Standalone Docker

Create your ignored `.env` from the root example and set `MCP_AUTH_TOKEN`, provider configuration, and provider credentials. No customer account, wallet, or payment setup is required. Listing targets and estimating runs do not make paid calls. Inline MCP arguments select models/search, so `TARGETS_JSON` is optional. The image includes `opensenpai.config.mjs` and `config/providers/`; bind-mount a trusted replacement module and its provider files to customize a local deployment, or rebuild the image for Cloudflare. Split API and worker processes must load the same modules. Supply any extra SDK dependencies when building your customized image.

```sh
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:4111/ready
```

The app runs `--role all --transport http` and stores libSQL in the `app-data` volume at `/app/data/opensenpai.db`. `/mcp` and REST resources under `/api/v1/research` require `Authorization: Bearer <MCP_AUTH_TOKEN>`. See the [API contract](../docs/api.md). Host port 4111 binds only to loopback. `/health` checks process liveness; `/ready` checks application readiness. The image runs as the unprivileged `node` user. Stop with `docker compose down`; named volumes persist until explicitly removed.

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

Both processes must share `WORKSPACE_ID` and provider configuration. Back up the database volume or remote service independently of container images. The split profile is intended for trusted private networks; database and Valkey ports are not published.

For a local file backup, stop the application cleanly, copy the research database and its sibling Mastra metadata database, then restart. Restore with the application stopped, preserving writable ownership. For remote libSQL, use the server or managed provider's snapshot/restore facilities. Keep provider credentials outside database backups.

## Cloudflare compute

The supplied Wrangler configuration deploys a single operator workspace. It uses Cloudflare-native persistence and needs no Turso account or remote libSQL database. Managed accounts, tenant routing, wallets, and payment resources are deployed from the private repository.

All application compute runs on Cloudflare: a Worker provides ingress and consumes Queues, while a Cloudflare Container runs the same native Node/Mastra application image. Research records live in the Container Durable Object’s SQLite storage, and native Mastra workflow metadata lives in D1. No application state depends on the container filesystem. This profile needs a Cloudflare account with Workers, Queues, and Containers enabled.

The installed `@mastra/mcp` 2.4.1 API exposes `startHTTP({req,res})` with Node `IncomingMessage` and `ServerResponse`; the package calls its Node HTTP handler. This compatibility gate selects Containers instead of substituting a hand-written MCP implementation in Workers. The Worker imports Cloudflare’s Containers adapter, deployment handlers, and the shared research storage implementation. Native MCP, the provider adapters, and Mastra stay inside the Linux image.

Cloudflare's [Container class](https://developers.cloudflare.com/containers/api/container-class/) supplies lifecycle management and runtime environment forwarding. Queue delivery is at least once; the [retry and dead-letter configuration](https://developers.cloudflare.com/queues/configuration/batching-retries/) retains failed deliveries after bounded retries.

Run local build checks from the repository root:

```sh
pnpm build
pnpm --filter @opensenpai/cloudflare typecheck
pnpm --filter @opensenpai/cloudflare test
pnpm exec wrangler deploy --dry-run --containers-rollout none --config apps/cloudflare/wrangler.json
docker build --platform linux/amd64 -t opensenpai:cloudflare .
```

The `--containers-rollout none` command verifies the Worker bundle and configuration without building an image or accessing an account. A complete `wrangler deploy --dry-run --config apps/cloudflare/wrangler.json` also builds the configured Linux image. CI runs the complete dry run and Docker build. Neither command publishes the Worker.

The committed D1 UUID is the inert all-zero placeholder. Create the databases and queues, set the returned D1 UUID in `apps/cloudflare/wrangler.json`, and supply runtime secrets before deploying:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create opensenpai-mastra --update-config=false
pnpm exec wrangler queues create opensenpai-observations
pnpm exec wrangler queues create opensenpai-observations-dlq
pnpm exec wrangler secret put MCP_AUTH_TOKEN --config apps/cloudflare/wrangler.json
pnpm exec wrangler secret put INTERNAL_EXECUTION_TOKEN --config apps/cloudflare/wrangler.json
```

Use independent random tokens for MCP and internal execution. Add each credential referenced by the provider modules with `wrangler secret put <ENV_NAME> --config apps/cloudflare/wrangler.json`. Provider string bindings are forwarded to the container at startup; database, queue, and Durable Object bindings stay in the Worker. Remote database URLs and Cloudflare account credentials are excluded. Set `WORKSPACE_ID` in `apps/cloudflare/wrangler.json`. The adapter sets `STORAGE_BACKEND=cloudflare`; no remote libSQL credentials are required.

Set `MCP_ALLOWED_HOSTS` in Wrangler vars to your public Worker hostname (without scheme or port). The adapter adds the private container hostname and loopback hosts. Set `MCP_ALLOWED_ORIGINS` for browser clients connecting from a different origin.

Deploy when the account and runtime configuration are ready:

```sh
pnpm exec wrangler deploy --config apps/cloudflare/wrangler.json
```

The Worker exposes `/mcp`, `/api/v1/research/*`, `/health`, and `/ready`. Internal observation endpoints are inaccessible through ingress. A single named container and one queue consumer limit application concurrency. Provider execution occurs only inside an awaited authenticated queue request, using the shared bounded observation workflow; generic detached Mastra workers and automatic research scheduling are disabled in this profile.

An accepted observation is persisted before dispatch. The Worker sends only `{ "observationId": "..." }` to the queue, then marks it queued in Durable Object SQLite. If sending succeeds but marking fails, a duplicate is safe because execution uses a durable compare-and-set claim. A minute Cron repairs dispatch for existing accepted observations; it does not create research runs. Each queue handler waits for terminal persistence before acknowledging. Nonterminal, timeout, network, and malformed-message failures retry. `max_batch_size=1`, `max_concurrency=1`, and three retries are configured; exhausted messages go to `opensenpai-observations-dlq`. Inspect the DLQ in the Cloudflare dashboard and diagnose the durable observation before replaying its ID. Replaying an already terminal observation does not execute another paid call.

The private `http://cloudflare-storage` outbound host gives the container access to workspace-scoped research methods and D1 queries. Public ingress never routes these handlers, and no Cloudflare account API token enters the container. The research adapter preserves the existing interactive transaction boundaries using Cloudflare storage transactions. See [the persistence design](../docs/cloudflare-storage.md).

The container may sleep after five idle minutes; Cloudflare storage preserves state across restarts. Cold starts can delay readiness. No live Cloudflare deployment or paid provider call is part of the local compatibility tests.
