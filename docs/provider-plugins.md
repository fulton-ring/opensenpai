# Provider configuration and MCP model selection

Agents select models and search separately through `start_run`. The bundled registry contains the `openrouter` model adapter and `exa` controlled retrieval adapter. There are no built-in target presets.

```json
{
  "prompts": [{ "id": "comparison", "text": "Compare AEO research services using public evidence." }],
  "targets": [{
    "id": "glm-exa",
    "provider": "openrouter",
    "model": "z-ai/glm-5.3-flash",
    "search": { "mode": "controlled", "engine": "exa", "max_results": 3 },
    "max_output_tokens": 512
  }],
  "idempotency_key": "comparison-001",
  "max_estimated_cost_usd": 0.5
}
```

Call `list_targets` with `{ "provider": "openrouter", "model_query": "glm", "limit": 10 }` to discover current model IDs. Without query arguments it lists installed adapters and optional presets without fetching a catalog. Search modes are `off`, shared `controlled` retrieval, provider `native` search, and model-driven `server` search with a named engine. OpenRouter server engines include Exa, Perplexity, Parallel, and Firecrawl; another adapter decides which modes it supports.

Endpoint selection is operator configuration, not an MCP/REST tool option. OpenRouter automatically routes and fails over among healthy standard-tier endpoints that advertise the requested capability. The adapter supplies a compatible allowlist without forcing an order, excludes incompatible/tier variants, and requires parameter support. It preserves the requested model and search engine and verifies execution evidence after generation. Operator presets may still pin an endpoint through `provider_options.provider`. Reservations use the maximum compatible catalog rates; execution excludes routes whose prices exceed those reserved rates and charges provider-reported usage. Caller arguments cannot supply credentials, API URLs, pricing, endpoint pins, or arbitrary model-provider options. Unpriced selections cannot run with an estimated spend cap. Rate limits are reported as `provider_http_429` without asking callers to manage upstream endpoints.

## One module per provider

[../opensenpai.config.mjs](../opensenpai.config.mjs) imports individual files under `config/providers/` and registers them. Add a file, then register its exported adapter. No workflow, MCP, or storage changes are required.

For an OpenAI-compatible competitor, create `config/providers/gateway.mjs`:

```js
import { createOpenAICompatibleProvider } from "@opensenpai/core/providers";

/** Operator-configured gateway; rates must match your chosen models and account. */
export default createOpenAICompatibleProvider({
  name: "gateway",
  baseURL: "https://your-gateway.example/v1",
  apiKeyEnv: "GATEWAY_API_KEY",
  // Example rates only: replace with trusted rates, or a per-model callback.
  pricing: { input_per_million: 1, output_per_million: 2, search_per_request: 0 },
});
```

Then import it in `opensenpai.config.mjs` and add `gateway` under `models`. Set `GATEWAY_API_KEY` in the runtime environment. An agent can immediately submit `{ "provider": "gateway", "model": "your-model", "search": { "mode": "controlled", "engine": "exa" }, "id": "comparison" }`. The same helper can point at OpenAI's chat-completions endpoint with an operator-supplied key. Direct vendor adapters are not bundled.

For another Mastra-compatible SDK, install that SDK and export `createSdkProvider({ createModel, ... })` from the provider file. `createModel(input, context)` returns `{ model, tools?, providerOptions? }`, where `model` is the SDK language model for `input.target.model`. Build it using `context.env` credentials and `context.fetch` so HTTP evidence is captured. Supply `resolveTarget(target, context)` for trusted pricing and `listModels(query, context)` for optional model discovery. See the exported `SdkProviderOptions` and `ModelProvider` types.

The wrapper handles bounded generation, zero automatic retries, usage and source normalization, raw responses, and preservation of charge evidence after verification failures. A custom SDK's native search requires explicit tools and a `verify` hook; adding a model factory alone does not establish search support. Low-level protocols can implement `ModelProvider` directly. Custom shared search providers implement `RetrievalProvider` (`availability`, `estimate`, `retrieve`) and register under `retrievals`. Controlled search `options` are passed to that adapter; the adapter validates its own options.

## Configuration loading and deployment

Configuration is trusted executable operator code. The Node application loads a local `.js`/`.mjs` default export containing `{ providers?, targets? }`; remote URLs and TypeScript files are rejected. `--config` overrides `OPENSENPAI_CONFIG`, otherwise the conventional filename is used. An explicitly missing or invalid module fails startup. If the implicit conventional file is absent, the bundled registry and empty presets are used.

Programmatic `providers`/`targets` options take precedence over module settings. `TARGETS_JSON` overrides module presets only. Accepted runs replay from their saved input/snapshot before provider metadata or credential checks; changing the caller input under the same idempotency key conflicts. Existing string target IDs remain supported when operators define named presets; agents do not need them for inline selection. Adapter IDs start with a letter and contain up to 80 letters, digits, underscores, or hyphens.

The Docker image includes the root configuration and provider modules. Mount replacement modules for local deployment, or rebuild the image with additional SDK dependencies for Cloudflare. Split API and worker processes must use the same provider configuration and credentials. Agent-facing MCP inputs cannot load modules or change credentials.

## Strict OpenRouter search

OpenRouter is the sole bundled model gateway; Exa supplies shared controlled retrieval. Direct OpenAI, Anthropic, Vertex, and Perplexity clients have been removed. OpenRouter handles failover between compatible serving endpoints for the same model and search engine. Perplexity Sonar uses intrinsic search without an unsupported server tool.

Native capability filtering is specific to `packages/core/src/providers/openrouter.ts`. Before resolving an inline selection and again immediately before any generation (including named presets), the adapter reads current endpoint metadata. A native request requires a nonempty provider tool type in `native_tools["openrouter:web_search"]`; unsupported or unknown capability metadata is rejected. Intrinsic Sonar search is handled by its existing Perplexity route. All compatible endpoints are allowed, with OpenRouter handling load balancing and failover. An operator-pinned preset remains pinned and fails if its capability is lost. Catalog errors and inactive endpoints also fail before paid generation. Explicit server Exa/Perplexity requests and controlled shared retrieval do not require native search capability. No OpenRouter-specific filtering lives in the shared MCP, service, or workflow code.

All search modes use `OPENROUTER_API_KEY` by default. A separate key can be selected in the provider module with `nativeSearch: { apiKeyEnv: "YOUR_NATIVE_KEY" }`, but no separate workspace or policy declaration is required. Configure workspace engine restrictions only if you want an additional upstream safeguard; restricting a workspace to native search also blocks intentional OpenRouter-managed Exa/Perplexity searches through that workspace.

The adapter validates returned model, provider, search execution, and engine using positive executed-search counters plus matching OpenRouter response-pipeline evidence or read-only generation metadata. Native pipeline mode and the named web-search tool establish native execution; SDK execution requires its explicit engine list. Contradictory model/provider/engine evidence fails even when another source claims success. Generation analytics returning 404 do not invalidate complete proof from the response. Missing or mismatched proof fails the observation while retaining raw output and incurred usage. Preflight rejects unsupported requests but cannot guarantee correct upstream metadata or execution, and a rejected result cannot undo upstream charges. No paid generation is automatically retried. Tests cover both proof sources using the response shapes retained from real provider calls.

Search-enabled OpenRouter requests explicitly ask the model to search before answering, but enabling a server tool does not guarantee that the model will call it. Completed results still require verified search execution and the requested engine. Reasoning models share their output budget with reasoning; if output is truncated before a search, increase `max_output_tokens` or select a supported lower `reasoning_effort`. No search request is silently replaced with another engine.
