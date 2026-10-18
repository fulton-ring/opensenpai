# OpenSenpai

Built and maintained by [Fulton Ring](https://fultonring.com).

OpenSenpai is an MCP and REST service for running bounded research experiments across model providers and search modes. An external agent supplies prompts, chooses targets, starts a run, and retrieves durable results for its own analysis. That agent owns scheduling and synthesis; OpenSenpai executes accepted work through native Mastra workflows and stores evidence in libSQL locally or Cloudflare-native databases when hosted.

The pnpm/Turborepo workspace contains:

- `packages/core`: the `@opensenpai/core` SDK, with contracts, provider adapters, target catalog, storage, and workflows.
- `apps/server`: the `@opensenpai/server` SDK, Node CLI, MCP tools, and authenticated REST/HTTP transport.
- `apps/cloudflare`: Worker ingress, queue delivery, and Cloudflare Container integration.

The managed service lives in the separate private repository `../opensenpai-web`: its landing page, dashboard, account gateway, identity adapters, wallets, payments, and tenant routing are independent of the public research engine. This repository provides self-hosted research with your own provider credentials and no service fees or account/payment setup. Public builds and Docker images require no private checkout or frontend assets.

## Local setup

Use Node **24 or newer** and **pnpm 10.30.0**.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Fill in your provider credentials and a random MCP_AUTH_TOKEN of at least 16 characters.
pnpm build
pnpm start --role all --transport http
```

The server defaults to `http://127.0.0.1:4111`; MCP is at `/mcp`, and REST resources are under `/api/v1/research`. Both HTTP interfaces use the operator bearer token. See the [API and SDK contract](docs/api.md). `/health` checks liveness and `/ready` checks readiness. Keep credentials in your ignored `.env` or inject them at runtime. The service uses your provider accounts; calling `start_run` can incur charges.

The bundled model gateway is OpenRouter; shared retrieval uses Exa. Set `OPENROUTER_API_KEY` and, for controlled Exa retrieval, `EXA_API_KEY`. Perplexity server search runs through OpenRouter and needs no separate Perplexity key. Direct vendor integrations are no longer bundled.

Agents choose a model and search mode independently in MCP arguments. There are no default preset aliases to maintain. `list_targets` returns installed model/retrieval adapters and any optional operator presets. To discover models, call it with `{ "provider": "openrouter", "model_query": "glm", "limit": 10 }`. Discovery and model/pricing resolution may make read-only metadata requests; they never generate paid answers.

Provider adapters live in individual files under `config/providers/`, registered by [opensenpai.config.mjs](opensenpai.config.mjs). Add a provider file and register it there to use another gateway or Mastra-compatible SDK. `OPENSENPAI_CONFIG` or `--config` selects a different trusted local `.mjs`/`.js` configuration. Credentials stay in environment variables. Optional named presets can be supplied through that module or `TARGETS_JSON`. See [provider configuration](docs/provider-plugins.md).

`pnpm dev` runs the Node server from TypeScript. `pnpm studio` opens native Mastra Studio for local workflow inspection. Stop the regular server first when using the same local database. Studio exposes development workflow routes and should stay on a trusted local machine; deploy the authenticated server for remote clients.

## Connect an agent

For Streamable HTTP, use the MCP URL and bearer token. A client supporting this configuration format can use:

```json
{
  "mcpServers": {
    "aeo": {
      "type": "http",
      "url": "http://127.0.0.1:4111/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

For stdio, let the client launch its own combined server. Use absolute paths because the client's working directory may differ:

```json
{
  "mcpServers": {
    "aeo": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/opensenpai/.env",
        "/absolute/path/opensenpai/apps/server/dist/cli.js",
        "--role", "all",
        "--transport", "stdio",
        "--database-url", "file:/absolute/path/opensenpai/data/agent.db"
      ]
    }
  }
}
```

Stdio needs no HTTP bearer token. Use a separate local database for each application process; do not point multiple running servers at the same writable file.

## Research through seven tools

| Tool | Purpose |
| --- | --- |
| `list_targets` | Discover installed adapters/models and inspect optional presets and observed capabilities. |
| `estimate_run` | Resolve model metadata and calculate observation counts and estimated spend without paid calls. |
| `start_run` | Persist and dispatch an accepted experiment. |
| `get_run` | Read status and counts; `wait_ms` can wait up to 10 seconds for a change. |
| `get_results` | Retrieve paginated observations; raw provider payloads are opt-in. |
| `list_runs` | Find recent runs, optionally filtered by project. |
| `cancel_run` | Stop pending observations and request cancellation of active work. |

For example, ask an agent: “Use OpenSenpai to evaluate Fulton Ring's public AI-readiness services. Discover models, select a model with controlled Exa retrieval, estimate one observation, start it only within the budget, then retrieve and summarize its sources and limitations.” The `estimate_run` and `start_run` arguments have the same shape:

```json
{
  "project": "fulton-ring",
  "prompts": [
    {
      "id": "ai-readiness",
      "text": "Assess the AI-readiness services described at https://fultonring.com. Cite public evidence and identify gaps."
    }
  ],
  "targets": [
    {
      "id": "glm-exa",
      "provider": "openrouter",
      "model": "z-ai/glm-5.3-flash",
      "search": { "mode": "controlled", "engine": "exa", "max_results": 3 },
      "max_output_tokens": 512
    }
  ],
  "repetitions": 1,
  "locale": "en-US",
  "idempotency_key": "fulton-ai-readiness-001",
  "max_estimated_cost_usd": 0.5
}
```

`start_run` returns `{ "run": { "id": "..." }, "created": true }`. Poll `get_run` with that `run_id`, then call `get_results` with `{ "run_id": "...", "include_raw": false }`. Compact results retain answers, source URLs/titles, citation locations, and usage; `include_raw:true` also includes full source text, metadata, and provider payloads. Follow `next_cursor` until it is null. Reusing the same idempotency key and payload returns the existing run; changing the payload under that key conflicts. The current limit is 100 observations per run.

Search is selected per target: `{ "mode": "off" }`, controlled retrieval as above, `{ "mode": "server", "engine": "perplexity", "max_uses": 1 }`, or `{ "mode": "native", "max_uses": 1 }`. OpenRouter server search also supports Exa, Parallel, and Firecrawl. Search support depends on the selected model and adapter.

OpenRouter validates native search per model/endpoint before paid generation. It reads current endpoint capabilities, rejects missing or malformed native search support, and pins a capable endpoint with provider fallback disabled. It rechecks a saved pin immediately before generation and refuses a pin that lost support. Explicit Exa/Perplexity selections remain available and do not require native support. All modes use `OPENROUTER_API_KEY` by default; a separate workspace/key is optional, not required.

The response guard requires executed search counters plus matching model/provider/engine proof from OpenRouter response metadata or generation analytics. Conflicting evidence fails. Unavailable analytics alone do not invalidate proof already present in the response. Missing proof or a substituted engine still fails while preserving raw evidence and incurred usage. This preflight protects against unsupported requests; it cannot guarantee that OpenRouter's metadata or execution is correct. A native-only workspace restriction is an optional additional safeguard against upstream search fallback, but would block intentional OpenRouter-managed Exa/Perplexity requests using that workspace. No such workspace-wide restriction is required by the application.

Native search lets the provider decide how to search. Controlled Exa retrieval shares an immutable source bundle across matching observations, making comparisons easier. Retrieved sources, provider citations, and URLs extracted from answer text are stored separately. They are not interchangeable evidence of search execution.

## Results and spend

Observations can be `pending`, `running`, `succeeded`, `failed`, `cancelled`, or `unknown_outcome`. A dispatched request whose outcome cannot be established is retained as unknown; it is not automatically retried as another paid call. Cancellation can leave incurred costs and useful outputs. Inspect durable attempts before deliberately submitting replacement work.

Results retain requested and returned models, serving-provider metadata where available, search activity, citations, sources, usage, and errors. Missing token counts or charges remain null. Estimated cost and reported cost are distinct: `max_estimated_cost_usd` gates the estimate before dispatch, not the vendor's final bill. Reservations remain when charges are uncertain. Back up the research and Mastra databases independently of container images.

## Deployment and roles

The combined `all` role is the default for local use. The `api` role accepts runs; the `worker` role executes them. Native split deployments require shared remote `DATABASE_URL`, optional `DATABASE_AUTH_TOKEN`, and `VALKEY_URL`. API and worker must use the same `WORKSPACE_ID` and provider configuration. Workers require an `INTERNAL_EXECUTION_TOKEN` of at least 16 characters, distinct from the MCP token.

Standalone Docker, split Compose with libSQL/Valkey, and Cloudflare deployment instructions are in [deploy/README.md](deploy/README.md). Cloudflare uses Worker ingress and Queues with the native Node application in a Container, backed by Durable Object SQLite for research records and D1 for Mastra workflow metadata. Its repair Cron dispatches already accepted work; it does not schedule new research experiments.

The supplied deployments serve one trusted operator workspace using provider credentials from your environment. They include no managed accounts, wallets, payment processing, or customer fees. The [hosted service boundary](docs/hosted-service.md) describes how an external application can consume the public SDK and supply optional authorization and execution hooks. Managed account APIs and operator configuration belong to the private repository.

## Verification

```sh
pnpm check
```

Biome enforces a maximum of 999 lines per source file, including blank lines. `pnpm lint` also checks that source, test, and script directories contain at most ten direct files; repository-root configuration files are exempt. `pnpm lint` also requires JSDoc on public source exports and exactly one blank line between functions/methods. `pnpm format` fixes formatting and function spacing; authors write meaningful JSDoc. Barrel re-exports and test files are exempt from documentation checks. CI runs these checks. Function-size, complexity, explicit typing, and floating-promise rules provide the JPL-style guardrails.

Normal tests use deterministic fixtures. Paid external-agent acceptance is opt-in and requires a Claude CLI, explicit agent credentials, service credentials for the selected model/search adapters, and a running HTTP server. The default agent provider is Anthropic and requires `ANTHROPIC_API_KEY`:

```sh
OPENSENPAI_LIVE_TESTS=1 \
  pnpm exec tsx --env-file=.env scripts/e2e-real-agent.ts --transport http \
  --research-model z-ai/glm-5.3-flash --search-engine exa
```

To use funded OpenRouter credits for the external agent, set `E2E_AGENT_PROVIDER=openrouter` and supply `OPENROUTER_API_KEY`. The harness uses the [documented Claude Code gateway integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration), setting the child's bearer token and gateway URL while blanking its direct Anthropic API key. The default model is `anthropic/claude-haiku-5.5`; `--model` or `E2E_AGENT_MODEL` can override it. Provider selection does not change the parent environment or service configuration. `--model` selects the external agent; repeatable `--research-model` flags select research models. `--research-provider` selects the installed model adapter, and `--search-engine` accepts `exa`, `perplexity`, `native`, or `off`. Optional `--target`/`E2E_TARGETS` selects explicitly configured presets.

Add `--full` for five Fulton Ring research prompts, or use `--transport stdio` to have the external agent launch a temporary server/database. For custom stdio credentials, explicitly list their environment variable names in `E2E_SERVER_ENV_KEYS`; the configured values go only to the MCP server. Stdio uses the repository configuration by absolute path, or `OPENSENPAI_CONFIG`. The harness isolates its working directory and Claude configuration, disables built-in tools and other MCP servers, and checks native tool calls against persisted server audits and results. Redacted transcripts, reports, and the cumulative spend ledger live in `.artifacts/real-agent/`.

Each suite defaults to reserving $2 for the external agent and $1 for application calls; its run requests an estimated cap of $0.50. New suite reservations stop at $10 cumulative accounted spend, leaving $5 headroom in the $15 acceptance budget. Failed or unknown outcomes retain full allowances, and known overruns remain charged. OpenRouter agent suites retain at least the full reserved agent allowance because CLI cost estimates can differ from gateway billing; reports preserve the raw CLI figure and selected provider. Keep the same ledger between invocations. This is conservative local accounting, not an absolute guarantee of vendor charges.

## License

[Apache License 2.0](LICENSE).

## Container releases and security

The [container release guide](deploy/README.md#published-images) documents GHCR tags, Linux AMD64/ARM64 support, immutable digests, and the one-time package visibility setting. Managed service images and deployment remain in the private `opensenpai-web` repository. See [SECURITY.md](SECURITY.md) for secret scanning, dependency monitoring, and the remaining assessed transitive advisory.
