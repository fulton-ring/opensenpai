# OpenSenpai implementation plan

Approved scope: MCP-first research execution with native Mastra facilities, libSQL, standalone/split Docker, all-Cloudflare deployment support, and real external-agent acceptance. External agents own scheduling and synthesis. No customer billing, accounts, research scheduler, customer UI, Postgres adapter, or Kubernetes manifests in this release.

## Tasks
- [x] Foundation: contracts, pinned dependencies, strict TypeScript, Biome/JPL checks, Vitest, Git isolation.
- [x] Storage: migrations, immutable observations, attempts, usage, idempotency, atomic claiming, cancellation, dispatch intent.
- [x] Providers: native integrations for OpenAI/Anthropic/Vertex, explicit Perplexity Agent API, OpenRouter, controlled Exa retrieval, complete raw evidence.
- [x] Runtime: bounded Mastra observation workflows, combined/API/worker modes, no hidden paid retries, truthful recovery.
- [x] MCP: list_targets, estimate_run, start_run, get_run, get_results, list_runs, cancel_run; HTTP bearer auth and stdio.
- [x] Deployment: Docker, split Compose/libSQL/Valkey, Workers+Queues+remote libSQL; Cloudflare Containers fallback if runtime compatibility fails.
- [x] Verification: deterministic failure/concurrency/restart tests; actual external-agent MCP calls with correlated persistent evidence.
- [x] Documentation/CI: commands, configuration, credentials, backup/restore, budgets, native-vs-controlled interpretation.

## Invariants
Provider calls happen only for explicitly accepted experiments. Attempts are persisted before dispatch; ambiguous outcomes never automatically issue another paid call. Duplicate submission keys conflict when payloads differ. Retrieved sources, citations, and extracted URLs remain distinct. Missing usage is null, not zero. Cancelled calls retain incurred usage and outputs. Outbox repair handles accepted work only.

## Live acceptance budget
User approved up to $15 cumulative for model/search/test-agent calls. Stop new dispatch at $10 committed/reported/reserved spend and retain $5 headroom. Paid tests are explicit opt-in; normal CI uses mocks. Do not record credentials in fixtures or transcripts.

## Parallel execution
Root owns contracts/manifests/lockfile and integration. Isolated worktrees and exclusive module ownership separate storage, providers, runtime, MCP, deployment, and test harness work. Spec review precedes final quality review. Cloudflare staging validation requires deployment credentials; local build/runtime checks and deployment scripts remain required regardless.

## Acceptance evidence

Real Claude Code agents using the funded OpenRouter gateway completed all seven MCP tools over HTTP and stdio. HTTP ran five Fulton Ring prompts against router-exa and perplexity-native (10 successful observations); stdio ran one successful router-exa observation. Reports and redacted transcripts are in ignored `.artifacts/real-agent/`. Cumulative conservative accounting is $8.2229494, including retained allowances for failed or uncertain probes. No further paid acceptance dispatch is needed.

Standalone Docker, split API/worker with real Valkey and libSQL, service restart preservation, and duplicate terminal delivery through the Cloudflare adapter have been checked locally. Direct OpenAI and Anthropic accounts lack credit; Vertex billing is disabled. Perplexity and OpenRouter/Exa real calls succeeded. Cloudflare publication remains dependent on account credentials.

The user additionally requested files below 1,000 lines and at most ten files per source/test folder. Biome enforces 999 lines; the companion structure check runs inside `pnpm lint` and CI. Root configuration files are exempt by explicit user choice.

Final verification: `pnpm check` passes 182 deterministic tests plus lint (Biome and folder structure), strict typechecking, and all Turborepo builds. The complete Wrangler dry run also builds the Linux AMD64 production container successfully. Runtime/storage review confirms provider and shared-search authorization, late-result persistence, budget refusal, and lease recovery. No Cloudflare resources were published.
