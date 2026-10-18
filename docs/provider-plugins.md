# Provider configuration and MCP model selection

Agents select models and search separately through `estimate_run` and `start_run`. The bundled registry contains the `openrouter` model adapter and `exa` controlled retrieval adapter. There are no built-in target presets.

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

An optional `serving_provider` pins a particular OpenRouter endpoint tag. The adapter resolves trusted endpoint pricing and pins the route before saving the run. Caller arguments cannot supply credentials, API URLs, pricing, or arbitrary model-provider options. An adapter's metadata resolver may update pricing/routing, but cannot change the requested model, search, limits, or explicit serving-provider pin. Unpriced selections cannot run with an estimated spend cap.

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

OpenRouter is the sole bundled model gateway; Exa supplies shared controlled retrieval. Direct OpenAI, Anthropic, Vertex, and Perplexity clients have been removed. OpenRouter pins the serving endpoint and disables provider fallbacks. Perplexity Sonar uses intrinsic search without an unsupported server tool.

Strict native search requires `OPENROUTER_NATIVE_API_KEY` from a separate workspace whose Server Tools engine list is restricted to `native` with **Prevent overrides** enabled. The public workspace API cannot read or set this engine policy. [../config/providers/openrouter.mjs](../config/providers/openrouter.mjs) explicitly declares this operator-managed policy; that declaration does not configure or verify the remote setting. Missing the dedicated key leaves native selections unavailable. Do not reuse the general key as a substitute for configuring the workspace policy.

The adapter preflights endpoint capabilities and validates returned model, provider, search execution, and engine using response evidence and read-only generation metadata. Missing or mismatched proof fails the observation while retaining raw output and incurred usage. No paid generation is automatically retried. An abort cannot undo upstream charges. Native live behavior remains unverified until the dedicated workspace/key is available; no credentials are exported to Cloudflare by these local changes.
