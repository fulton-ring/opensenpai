# OpenSenpai implementation plan

Approved scope: MCP-first research execution with native Mastra facilities, libSQL, standalone/split Docker, all-Cloudflare deployment support, and real external-agent acceptance. External agents own scheduling and synthesis. No customer billing, accounts, research scheduler, customer UI, Postgres adapter, or Kubernetes manifests in this release.

## Tasks
- [ ] Foundation: contracts, pinned dependencies, strict TypeScript, Biome/JPL checks, Vitest, Git isolation.
- [ ] Storage: migrations, immutable observations, attempts, usage, idempotency, atomic claiming, cancellation, dispatch intent.
- [ ] Providers: native integrations for OpenAI/Anthropic/Vertex, explicit Perplexity Agent API, OpenRouter, controlled Exa retrieval, complete raw evidence.
- [ ] Runtime: bounded Mastra observation workflows, combined/API/worker modes, no hidden paid retries, truthful recovery.
- [ ] MCP: list_targets, estimate_run, start_run, get_run, get_results, list_runs, cancel_run; HTTP bearer auth and stdio.
- [ ] Deployment: Docker, split Compose/libSQL/Valkey, Workers+Queues+remote libSQL; Cloudflare Containers fallback if runtime compatibility fails.
- [ ] Verification: deterministic failure/concurrency/restart tests; actual external-agent MCP calls with correlated persistent evidence.
- [ ] Documentation/CI: commands, configuration, credentials, backup/restore, budgets, native-vs-controlled interpretation.

## Invariants
Provider calls happen only for explicitly accepted experiments. Attempts are persisted before dispatch; ambiguous outcomes never automatically issue another paid call. Duplicate submission keys conflict when payloads differ. Retrieved sources, citations, and extracted URLs remain distinct. Missing usage is null, not zero. Cancelled calls retain incurred usage and outputs. Outbox repair handles accepted work only.

## Live acceptance budget
User approved up to $15 cumulative for model/search/test-agent calls. Stop new dispatch at $10 committed/reported/reserved spend and retain $5 headroom. Paid tests are explicit opt-in; normal CI uses mocks. Do not record credentials in fixtures or transcripts.

## Parallel execution
Root owns contracts/manifests/lockfile and integration. Isolated worktrees and exclusive module ownership separate storage, providers, runtime, MCP, deployment, and test harness work. Spec review precedes final quality review. Cloudflare staging validation requires deployment credentials; local build/runtime checks and deployment scripts remain required regardless.
