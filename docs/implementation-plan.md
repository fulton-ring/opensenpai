# OpenSenpai implementation plan

Approved scope: MCP-first research execution with native Mastra facilities, local libSQL, standalone/split Docker, Cloudflare-native persistence, and real external-agent acceptance. External agents own scheduling and synthesis. No customer billing, accounts, research scheduler, customer UI, Postgres adapter, or Kubernetes manifests in this release.

## Tasks
- [x] Foundation: contracts, pinned dependencies, strict TypeScript, Biome/JPL checks, Vitest, Git isolation.
- [x] Storage: migrations, immutable observations, attempts, usage, idempotency, atomic claiming, cancellation, dispatch intent.
- [x] Providers: pluggable model/retrieval registries, OpenRouter gateway, shared SDK/OpenAI-compatible factories, controlled Exa retrieval, strict search evidence, and inline MCP model/search selection. Direct vendor clients removed.
- [x] Runtime: bounded Mastra observation workflows, combined/API/worker modes, no hidden paid retries, truthful recovery.
- [x] MCP: list_targets, estimate_run, start_run, get_run, get_results, list_runs, cancel_run; HTTP bearer auth and stdio.
- [x] Deployment: Docker, split Compose/libSQL/Valkey, Workers+Queues+Containers, Durable Object SQLite research records, and native Mastra D1 metadata.
- [x] Verification: deterministic failure/concurrency/restart tests; actual external-agent MCP calls with correlated persistent evidence.
- [x] Documentation/CI: commands, configuration, credentials, backup/restore, budgets, native-vs-controlled interpretation.

## Invariants
Provider calls happen only for explicitly accepted experiments. Attempts are persisted before dispatch; ambiguous outcomes never automatically issue another paid call. Duplicate submission keys conflict when payloads differ. Retrieved sources, citations, and extracted URLs remain distinct. Missing usage is null, not zero. Cancelled calls retain incurred usage and outputs. Outbox repair handles accepted work only.

## Live acceptance budget
User approved up to $15 cumulative for model/search/test-agent calls. Stop new dispatch at $10 committed/reported/reserved spend and retain $5 headroom. Paid tests are explicit opt-in; normal CI uses mocks. Do not record credentials in fixtures or transcripts.

## Parallel execution
Root owns contracts/manifests/lockfile and integration. Isolated worktrees and exclusive module ownership separate storage, providers, runtime, MCP, deployment, and test harness work. Spec review precedes final quality review. Cloudflare staging validation requires deployment credentials; local build/runtime checks and deployment scripts remain required regardless.

## Acceptance evidence

Before the provider refactor, real Claude Code agents using the funded OpenRouter gateway completed all seven MCP tools over HTTP and stdio. HTTP ran five Fulton Ring prompts against router-exa and perplexity-native (10 successful observations); stdio ran one successful router-exa observation. Reports and redacted transcripts are in ignored `.artifacts/real-agent/`. Cumulative conservative accounting is $8.2229494, including retained allowances for failed or uncertain probes. The inline-selection refactor receives a separate bounded smoke test below.

Standalone Docker, split API/worker with real Valkey and libSQL, service restart preservation, and duplicate terminal delivery through the Cloudflare adapter have been checked locally. Historical direct OpenAI and Anthropic accounts lack credit; Vertex billing is disabled. Those clients have now been removed. Historical Perplexity and OpenRouter/Exa real calls succeeded. Cloudflare OAuth access is available. D1 and queues are provisioned; publication awaits explicit authorization to export the application/provider secrets after automatic approval review rejected that upload.

The user additionally requested files below 1,000 lines and at most ten files per source/test folder. Biome enforces 999 lines; the companion structure check runs inside `pnpm lint` and CI. Root configuration files are exempt by explicit user choice.

Final verification: `pnpm check` passes 182 deterministic tests plus lint (Biome and folder structure), strict typechecking, and all Turborepo builds. The complete Wrangler dry run also builds the Linux AMD64 production container successfully. Runtime/storage review confirms provider and shared-search authorization, late-result persistence, budget refusal, and lease recovery. That verification preceded the Cloudflare-native persistence change. The follow-up design and current deployment status are tracked in [cloudflare-storage.md](cloudflare-storage.md).

## Provider and style follow-up

`pnpm check` passes 307 deterministic tests, strict typechecking, lint/structure/style checks, and all builds after the provider refactor. A real authenticated HTTP MCP client selected two inline models through the generic SDK gateway and shared exactly one Exa retrieval; provider traffic used localhost fixtures. No presets or code edits were needed for those selections. Metadata resolvers preserve caller model/search/limits and explicit serving-provider pins.

Individual provider files are registered in `opensenpai.config.mjs`; custom SDK factories require no core workflow edits. Default presets are empty. JSDoc is required for public exports, and adjacent function/method implementations use one blank line; `pnpm format` repairs spacing, while `pnpm lint` checks both rules. Native search live checks remain blocked by the missing dedicated OpenRouter workspace/key and unverified native telemetry shape.

The updated real external agent also passed all seven tools over stdio with an inline `openrouter` / `openai/gpt-6-luna` selection and controlled Exa retrieval: one successful observation, three sources, application-reported spend $0.007280025. Report: ignored `.artifacts/real-agent/e2e-1792293004529-8122.report.json`. Conservative cumulative accounting is $9.243736, including the full $1 agent allowance and application estimate; no further paid calls are planned.

Final review fixes preserve accepted-run idempotency across catalog/credential changes, retain partial multi-query retrieval evidence and uncertain-charge reservations, and settle pre-dispatch cancellation with known zero model usage. Real Miniflare Durable Object/D1 tests verify accepted-run lookup/replay after restart even when presets and provider credentials are unavailable. The complete Cloudflare dry run builds the updated Linux AMD64 production image and Worker successfully; nothing was published.
