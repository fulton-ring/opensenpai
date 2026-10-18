# Pluggable providers and strict OpenRouter research

The user approved replacing bundled direct OpenAI, Anthropic, Vertex, and Perplexity model clients with OpenRouter, while allowing operators to supply any Mastra/AI SDK compatible provider with minimal changes.

## Configuration boundary

`opensenpai.config.mjs` is trusted operator configuration, loaded by the Node application. It exports targets and a provider registry. `OPENSENPAI_CONFIG` selects another local module; the CLI also accepts `--config`. `TARGETS_JSON` remains an explicit targets-only override. Configuration contains environment variable names, never credentials. Docker copies the default module; operators can bind-mount a replacement and any local plugin modules. The same configuration is required in split API and worker processes.

The registry contains model adapters and shared retrieval adapters. Adapter IDs are open strings rather than a vendor enum. Unknown adapters fail before dispatch. The core exports a shared SDK adapter helper: an OpenAI-compatible gateway needs a base URL and key variable, while another SDK needs a model factory. Native search tools and verification are explicit optional hooks; a generic model factory does not promise arbitrary provider search compatibility. A low-level adapter can return the existing normalized result for protocols outside the SDK. No workflow, MCP, or storage edits are needed to register an adapter.

## Bundled behavior

OpenRouter is the sole bundled model adapter. Exa remains a shared retrieval adapter. Native, model-driven server search, controlled shared retrieval, and search-off modes remain distinguishable. OpenRouter server search supports explicit Perplexity and Exa engines. Native targets pin the serving endpoint and disable model-provider fallbacks. Perplexity Sonar is intrinsic search and must not receive an unsupported server tool.

Strict native search additionally requires a dedicated OpenRouter key in a workspace whose Server Tools engine list is locked to `native` with Prevent overrides enabled. The public workspace API cannot read or set this engine policy. Configuration must explicitly declare this operator-managed policy and provide its dedicated key; native targets remain unavailable otherwise. That declaration is not proof of the remote setting. The app preflights advertised endpoint capabilities and validates returned provider, search execution, and resolved engine using provider evidence/read-only generation metadata. Unsupported, mismatched, or unknown evidence fails the observation, preserving raw output and incurred usage. No paid generation is retried. An abort cannot undo an upstream charge.

## Implementation plan

- [ ] Generalize target schemas, define small typed registries, and expose model/retrieval estimates without hard-coded vendor switches. Add contract and custom-registry checks first.
- [ ] Replace direct provider clients with OpenRouter, shared SDK/OpenAI-compatible helpers, and Exa. Add request-shape, no-fallback, strict evidence, timeout, and unknown-cost tests. Remove obsolete direct-provider SDK tests and dependencies.
- [ ] Thread one registry through service validation, estimation, workflows, retrieval reservations, and execution. Verify custom providers work end to end and unknown providers never dispatch.
- [ ] Load trusted ESM configuration in the Node application/CLI, copy it into Docker, and document replacement modules. Test file resolution, invalid exports, explicit overrides, and model factory injection.
- [ ] Run lint, folder/file limits, typechecking, all tests and builds. Verify real MCP calls against a custom configured adapter locally. Live native-provider checks remain blocked until the dedicated policy/key exists; no credentials are exported to Cloudflare.

Root owns shared schemas, manifests/lock, default catalog, top-level module, documentation, and integration. Independent agents own provider implementations, runtime/service wiring, and Node configuration loading in isolated worktrees. Review checks cover safety of policy claims, pre-dispatch validation, usage preservation, shared retrieval pricing, and provider-specific changes staying out of workflow code.
