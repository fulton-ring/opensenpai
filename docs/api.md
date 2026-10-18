# Research API and SDK

OpenSenpai exposes the same workspace-scoped research service through MCP, REST, and the public TypeScript SDK. Self-hosting uses your provider credentials and has no customer wallet or service fee. Managed account and payment APIs belong to the separate private application.

## HTTP access

The default origin is `http://127.0.0.1:4111`. Send `Authorization: Bearer <MCP_AUTH_TOKEN>` to `/mcp` and every `/api/v1/research` resource. `/health` and `/ready` are unauthenticated process/readiness checks. Browser clients must use an allowed Host and Origin; configure `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` for your deployment. Internal execution endpoints are not a public integration API.

REST requests and responses use JSON. POST and PATCH bodies require `Content-Type: application/json` and one JSON object, limited to 1 MiB. Query parameters are resource-specific: unknown or repeated parameters are rejected. URL-encode each run ID as a single path segment. Responses use `Cache-Control: no-store`.

| Resource | MCP equivalent | Request and response |
| --- | --- | --- |
| `GET /api/v1/research/targets` | `list_targets` | Optional `provider`, `model_query`, and `limit` (1–50, default 20). Returns `model_providers`, `retrieval_providers`, configured `targets`, and optional `model_provider`/`models` discovery data. |
| `POST /api/v1/research/estimates` | `estimate_run` | Run input below. Returns `total_observations`, estimated model/retrieval costs, `unpriced_targets`, and per-observation estimates; no paid generation or search. |
| `POST /api/v1/research/runs` | `start_run` | Run input below. Returns `{run, created}`: 201 plus a relative `Location` when created; 200 on an identical idempotent replay. |
| `GET /api/v1/research/runs` | `list_runs` | Optional `project`, `limit` (1–100, default 25), opaque `cursor`, or legacy `before` timestamp. Returns `{runs, next_cursor}`. |
| `GET /api/v1/research/runs/:id` | `get_run` | Optional `wait_ms` (0–10000, REST default 0). Returns the run record directly; a wait ends on change, terminal state, or timeout. |
| `GET /api/v1/research/runs/:id/observations` | `get_results` | Optional `target_id`, `prompt_id`, `status`, nonnegative integer `cursor`, `limit` (1–100, default 25), and `include_raw=true\|false` (default false). Returns `{observations, next_cursor}`. |
| `PATCH /api/v1/research/runs/:id` | `cancel_run` | Body `{ "cancel_requested": true }`, without query parameters. Returns the updated run directly. Cancellation can leave incurred costs and completed evidence. |

Follow each returned `next_cursor` until null. Run-list cursors are opaque strings; observation cursors are ordinal numbers. Do not interchange them. A run has aggregate status `queued`, `running`, `succeeded`, `partial`, `failed`, or `cancelled`; individual observations can also have `unknown_outcome`.

MCP uses the seven tool names above at `/mcp`, with `run_id` in read/cancel tool arguments. MCP `get_run` defaults to a 1000 ms wait. See the [agent connection examples](../README.md#connect-an-agent).

## Selecting models and search

Discover available adapters with `GET /api/v1/research/targets`. Add `?provider=openrouter&model_query=glm&limit=10` to query its model catalog. Discovery and estimation can make read-only metadata requests, but do not generate paid answers. Choose model IDs from discovery rather than assuming a catalog entry is still available.

POST the same request shape to `estimates` and `runs`:

```json
{
  "project": "example",
  "prompts": [
    { "id": "question", "text": "Compare the public evidence for this research question." }
  ],
  "targets": [
    {
      "id": "chosen-model",
      "provider": "openrouter",
      "model": "MODEL_ID_FROM_DISCOVERY",
      "search": { "mode": "controlled", "engine": "exa", "max_results": 3 },
      "max_output_tokens": 512
    }
  ],
  "repetitions": 1,
  "locale": "en-US",
  "idempotency_key": "example-research-001",
  "max_estimated_cost_usd": 0.5
}
```

Each target can instead be an operator-configured preset ID. Inline targets select `provider`, `model`, and independent `search`; they cannot supply credentials, pricing, provider configuration, or workspace identity. Optional `serving_provider` pins a serving vendor where supported. Other execution settings include `max_output_tokens` (32–4096, default 512), `timeout_ms` (1000–120000, default 120000), `temperature` (0–2), and `reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). Availability depends on the adapter and model.

Search choices are:

- `{ "mode": "off" }`.
- `{ "mode": "native", "max_uses": 1 }` for model-native search.
- `{ "mode": "server", "engine": "perplexity", "max_uses": 1 }` for provider-managed search; available engines depend on the adapter.
- `{ "mode": "controlled", "engine": "exa", "max_results": 3 }` for shared immutable retrieval. Optional `max_characters` bounds source context (100–30000, default 12000); explicit prompt `queries` can provide 1–3 retrieval queries.

`max_uses` is 1–3; `max_results` is 1–10. Prompts require unique IDs and text of at most 8000 characters. A run accepts 1–25 prompts, 1–10 unique targets, and 1–5 repetitions, with at most 100 total observations. `repetitions` defaults to 1 and `locale` to `en-US`. The required idempotency key is 1–160 characters and scoped to the trusted workspace. Reusing it with changed input returns a conflict.

Estimates distinguish missing prices from known zero. `max_estimated_cost_usd` must be positive and at most 1000; it rejects unpriced or over-budget starts, but cannot guarantee the provider's final charge. Preserve unknown outcomes before deliberately retrying paid work. Normal observation responses retain normalized answers, citations, usage, and provenance. `include_raw=true` also returns full source text, provider payloads, and metadata.

## Errors

REST failures use `{ "error": { "code", "message", "retryable" } }` for research-domain errors. Authentication, routing, and method errors can have fewer fields. Relevant statuses are 400 for invalid input/domain refusal, 401 for invalid bearer authentication, 403 for rejected origins, 404 for an unknown run/resource, 405 with `Allow` for unsupported methods, 409 for idempotency conflicts, 413 for oversized bodies, 415 for non-JSON bodies, and 500 for unexpected failures. MCP tool failures carry the corresponding structured `error` in the tool result. Read durable run state before deciding whether another paid start is appropriate.

## TypeScript SDK

The packages are local, packable SDK dependencies; this checkout does not imply a published registry release. Build the public checkout before packing:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@opensenpai/server...
mkdir -p /tmp/opensenpai-sdk
pnpm --filter @opensenpai/core pack --pack-destination /tmp/opensenpai-sdk
pnpm --filter @opensenpai/server pack --pack-destination /tmp/opensenpai-sdk
```

Install both tarballs in a consumer and resolve `@opensenpai/core` to the matching packed version. The private workspace automates this with `scripts/prepare-sdk.mjs` and local pnpm overrides. SDK subpath exports are:

| Package | Entry points |
| --- | --- |
| `@opensenpai/core` | `/contracts`, `/targets`, `/service`, `/providers`, `/storage`, `/runtime`, `/storage/protocol`, `/storage/durable-sql` |
| `@opensenpai/server` | `/application`, `/config`, `/provider-config`, `/http`, `/mcp`, `/cloudflare-storage` |

For Node composition, `createApplication(env, options)` from `@opensenpai/server/application` loads trusted configuration/providers, creates storage and the Mastra runtime, and exposes `service`, `runtime`, `store`, `mcp`, and `close()`. Set `transport: "http"` to serve HTTP; `listen: false` permits embedding without opening a listener. The research service methods are `listTargets`, `estimateRun`, `startRun`, `getRun`, `getResults`, `listRuns`, and `cancelRun`.

Optional `authorizeRun`, `ExecutionHooks.authorize`, and `ExecutionHooks.settled` let a host apply its own policy and reconcile usage. They do not add customer billing by default. The host must resolve trusted workspace identity before constructing the application. See the [hosted service boundary](hosted-service.md) for integration responsibilities and [provider configuration](provider-plugins.md) for model adapters.

## MCP protocol compatibility

HTTP serves the 2025 initialize handshake and the 2026 self-contained protocol through the native SDK. A version-pinned pnpm patch in `patches/` switches Mastra 2.4.1's hardcoded HTTP `legacy: "reject"` to the SDK's `legacy: "stateless"`. Tool definitions, validation, execution, and authorization stay shared. Both ESM and CommonJS builds are patched; Docker copies the patch before dependency installation. Downstream package-manager roots must apply this patch too until Mastra exposes the setting. Stdio retains Mastra's default protocol.
