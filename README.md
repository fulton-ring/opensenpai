# OpenSenpai

OpenSenpai is an MCP service for running bounded research experiments across model providers and search modes. An external agent supplies prompts, chooses targets, starts a run, and retrieves durable results for its own analysis. That agent owns scheduling and synthesis; OpenSenpai executes accepted work through native Mastra workflows and stores evidence in libSQL.

The pnpm/Turborepo workspace contains:

- `packages/core`: contracts, provider adapters, target catalog, storage, and workflows.
- `apps/server`: Node CLI, MCP tools, and authenticated HTTP transport.
- `apps/cloudflare`: Worker ingress, queue delivery, and Cloudflare Container integration.

## Local setup

Use Node **24 or newer** and **pnpm 10.30.0**.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Fill in your provider credentials and a random MCP_AUTH_TOKEN of at least 16 characters.
pnpm build
pnpm start --role all --transport http
```

The server defaults to `http://127.0.0.1:4111`; MCP is at `/mcp`. `/health` checks liveness and `/ready` checks readiness. Keep credentials in your ignored `.env` or inject them at runtime. The service uses your provider accounts; calling `start_run` can incur charges.

Choose only the credentials needed by your targets:

| Target | Required configuration | Search |
| --- | --- | --- |
| `router-exa` | `OPENROUTER_API_KEY`, `EXA_API_KEY` | Shared Exa retrieval |
| `openai-exa` | `OPENAI_API_KEY`, `EXA_API_KEY` | Shared Exa retrieval |
| `router-plain` | `OPENROUTER_API_KEY` | Off |
| `openai-native` | `OPENAI_API_KEY` | Provider native |
| `anthropic-native` | `ANTHROPIC_API_KEY` | Provider native |
| `perplexity-native` | `PERPLEXITY_API_KEY` | Provider native |
| `vertex-native` | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`; optional `GOOGLE_VERTEX_PROJECT` | Provider native |

Vertex service-account JSON is decoded in memory. `GOOGLE_VERTEX_LOCATION` defaults to `global`. `TARGETS_JSON` can replace the catalog with explicit models, search settings, token limits, timeouts, and pricing. Call `list_targets` to inspect credential availability and the latest observed provider/search behavior; a configured target does not prove a search occurred.

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
| `list_targets` | Inspect configured targets, credentials, pricing, and observed capabilities. |
| `estimate_run` | Calculate observation counts and estimated spend without provider calls. |
| `start_run` | Persist and dispatch an accepted experiment. |
| `get_run` | Read status and counts; `wait_ms` can wait up to 10 seconds for a change. |
| `get_results` | Retrieve paginated observations; raw provider payloads are opt-in. |
| `list_runs` | Find recent runs, optionally filtered by project. |
| `cancel_run` | Stop pending observations and request cancellation of active work. |

For example, ask an agent: “Use OpenSenpai to evaluate Fulton Ring's public AI-readiness services. List targets, estimate a single `router-exa` observation, start it only within the budget, then retrieve and summarize its sources and limitations.” The `estimate_run` and `start_run` arguments have the same shape:

```json
{
  "project": "fulton-ring",
  "prompts": [
    {
      "id": "ai-readiness",
      "text": "Assess the AI-readiness services described at https://fultonring.com. Cite public evidence and identify gaps."
    }
  ],
  "targets": ["router-exa"],
  "repetitions": 1,
  "locale": "en-US",
  "idempotency_key": "fulton-ai-readiness-001",
  "max_estimated_cost_usd": 0.5
}
```

`start_run` returns `{ "run": { "id": "..." }, "created": true }`. Poll `get_run` with that `run_id`, then call `get_results` with `{ "run_id": "...", "include_raw": false }`. Follow `next_cursor` until it is null. Reusing the same idempotency key and payload returns the existing run; changing the payload under that key conflicts. The current limit is 100 observations per run.

Native search lets the provider decide how to search. Controlled Exa retrieval shares an immutable source bundle across matching observations, making comparisons easier. Retrieved sources, provider citations, and URLs extracted from answer text are stored separately. They are not interchangeable evidence of search execution.

## Results and spend

Observations can be `pending`, `running`, `succeeded`, `failed`, `cancelled`, or `unknown_outcome`. A dispatched request whose outcome cannot be established is retained as unknown; it is not automatically retried as another paid call. Cancellation can leave incurred costs and useful outputs. Inspect durable attempts before deliberately submitting replacement work.

Results retain requested and returned models, serving-provider metadata where available, search activity, citations, sources, usage, and errors. Missing token counts or charges remain null. Estimated cost and reported cost are distinct: `max_estimated_cost_usd` gates the estimate before dispatch, not the vendor's final bill. Reservations remain when charges are uncertain. Back up the libSQL database, not just container images.

## Deployment and roles

The combined `all` role is the default for local use. The `api` role accepts runs; the `worker` role executes them. Native split deployments require shared remote `DATABASE_URL`, optional `DATABASE_AUTH_TOKEN`, and `VALKEY_URL`. API and worker must use the same `WORKSPACE_ID` and target configuration. Workers require an `INTERNAL_EXECUTION_TOKEN` of at least 16 characters, distinct from the MCP token.

Standalone Docker, split Compose with libSQL/Valkey, and Cloudflare deployment instructions are in [deploy/README.md](deploy/README.md). Cloudflare uses Worker ingress and Queues with the native Node application in a Container, backed by remote libSQL. Its repair Cron dispatches already accepted work; it does not schedule new research experiments.

Workspace-scoped storage and execution authorization/settlement hooks provide a foundation for a hosted service. The CLI uses one trusted `WORKSPACE_ID`; customer authentication, account provisioning, subscriptions, and billing are not implemented. A hosted integration must resolve workspace identity before constructing the service and supply its own authorization policy.

## Verification

```sh
pnpm check
```

Normal tests use deterministic fixtures. Paid external-agent acceptance is opt-in and requires a Claude CLI, explicit agent credentials, service credentials for the selected target, and a running HTTP server. The default agent provider is Anthropic and requires `ANTHROPIC_API_KEY`:

```sh
OPENSENPAI_LIVE_TESTS=1 E2E_TARGETS=router-exa \
  pnpm exec tsx --env-file=.env scripts/e2e-real-agent.ts --transport http
```

To use funded OpenRouter credits for the external agent, set `E2E_AGENT_PROVIDER=openrouter` and supply `OPENROUTER_API_KEY`. The harness uses the [documented Claude Code gateway integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration), setting the child's bearer token and gateway URL while blanking its direct Anthropic API key. The default model is `anthropic/claude-haiku-5.5`; `--model` or `E2E_AGENT_MODEL` can override it. Provider selection does not change the parent environment or service target configuration.

Add `--full` for five Fulton Ring research prompts, or use `--transport stdio` to have the external agent launch a temporary server/database. The harness isolates its working directory and Claude configuration, disables built-in tools and other MCP servers, and checks native tool calls against persisted server audits and results. Redacted transcripts, reports, and the cumulative spend ledger live in `.artifacts/real-agent/`.

Each suite reserves up to $2 for the external agent and $1 for application calls; its run requests an estimated cap of $0.50. New suite reservations stop at $10 cumulative accounted spend, leaving $5 headroom in the $15 acceptance budget. Failed or unknown outcomes retain full allowances, and known overruns remain charged. OpenRouter agent suites retain at least the full $2 agent allowance because CLI cost estimates can differ from gateway billing; reports preserve the raw CLI figure and selected provider. Keep the same ledger between invocations. This is conservative local accounting, not an absolute guarantee of vendor charges.

## License

[Apache License 2.0](LICENSE).
