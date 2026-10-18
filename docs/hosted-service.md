# Hosted service boundary

The public OpenSenpai repository provides the research engine, provider configuration, MCP and REST transports, durable storage, and optional integration hooks. Self-hosted deployments use one trusted `WORKSPACE_ID` and operator-supplied provider credentials. They require no customer account, wallet, payment provider, or service fees; provider usage is charged directly to the operator's accounts.

The managed service lives in the separate private repository `../opensenpai-web`. Its web frontend, account gateway, identity adapters, wallets, payment processing, promotional credits, and tenant routing are maintained and deployed there. Its operator guide is `../opensenpai-web/docs/hosted-service.md`. No private package or frontend export is required to build, test, or deploy this public repository.

## Public SDK and transports

`@opensenpai/core` exposes research contracts, provider adapters, workspace-scoped storage, the research service, and the execution runtime. `@opensenpai/server` provides Node application composition and MCP/REST transport integration. Applications can consume these public SDK packages without copying the research engine into their own repositories. See the [API and SDK contract](api.md) for package entry points, request shapes, authentication, and pagination.

The standalone HTTP server exposes seven research tools at `/mcp` and REST resources under `/api/v1/research`. Both use the configured operator bearer token. The public service does not expose managed account, credential-management, wallet, purchase, or payment endpoints. Research scheduling and synthesis remain the calling agent's responsibility.

Provider configuration stays in `opensenpai.config.mjs` and `config/providers/`, or a trusted module selected through `OPENSENPAI_CONFIG` or `--config`. Provider credentials come from environment variables. This configuration works independently of any managed service; see [provider configuration](provider-plugins.md).

## Optional integration hooks

An embedding application resolves a trusted workspace before constructing a research service. Tool arguments and unverified request headers must not choose a different customer's workspace. The supplied single-operator CLI uses its configured `WORKSPACE_ID`; a multi-tenant host owns authentication, tenant routing, and account policy.

The runtime accepts optional `ExecutionHooks`:

- `authorize(attempt)` runs before a paid model or shared-retrieval operation. A host can reject work or reserve its own allowance using the workspace, run, observation, and stable attempt identifiers.
- `settled(attempt, outcome, usage)` delivers durable execution evidence to the host. Reconcile by operation and attempt identity so repeated delivery cannot apply a charge twice. Shared retrieval uses its shared bundle identifier and should be accounted for once.

These callbacks carry research usage evidence; they do not implement a wallet, payment rail, signup grant, or price policy. The default runtime has no customer billing behavior when hooks are absent. A host that adds financial accounting owns its ledger, authorization policy, payment verification, and reconciliation.

Estimated costs and reported usage remain distinct. Unknown prices or outcomes require an explicit host policy; missing usage must not be treated as known zero cost. `max_estimated_cost_usd` gates estimated spend before dispatch and does not guarantee the upstream provider's final charge. Preserve uncertain attempts and reconcile their evidence before deliberately submitting replacement paid work.

## Deployment boundary

The public Docker and Cloudflare profiles deploy the research service for one operator workspace. Cloudflare uses Worker ingress and Queues, a native Node/Mastra Container, Durable Object SQLite research storage, and D1 workflow metadata. Infrastructure repair dispatches already accepted work; it does not create scheduled experiments. See [deployment instructions](../deploy/README.md).

Managed identity, account/payment APIs, customer routing, and web hosting belong to the private deployment. Their secrets and environment configuration are not part of the public CLI or deployment examples.
