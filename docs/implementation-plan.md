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
User approved up to $15 cumulative for model/search/test-agent calls. The original dispatch limit was $10; the user explicitly raised it to $12 for the corrected customer-question exercise below. Retain $3 headroom under the overall cap. Paid tests are explicit opt-in; normal CI uses mocks. Do not record credentials in fixtures or transcripts.

## Parallel execution
Root owns contracts/manifests/lockfile and integration. Isolated worktrees and exclusive module ownership separate storage, providers, runtime, MCP, deployment, and test harness work. Spec review precedes final quality review. Cloudflare staging validation requires deployment credentials; local build/runtime checks and deployment scripts remain required regardless.

## Acceptance evidence

Before the provider refactor, real Claude Code agents using the funded OpenRouter gateway completed all seven MCP tools over HTTP and stdio. HTTP ran five Fulton Ring prompts against router-exa and perplexity-native (10 successful observations); stdio ran one successful router-exa observation. Reports and redacted transcripts are in ignored `.artifacts/real-agent/`. Cumulative conservative accounting is $8.2229494, including retained allowances for failed or uncertain probes. The inline-selection refactor receives a separate bounded smoke test below.

Standalone Docker, split API/worker with real Valkey and libSQL, service restart preservation, and duplicate terminal delivery through the Cloudflare adapter have been checked locally. Historical direct OpenAI and Anthropic accounts lack credit; Vertex billing is disabled. Those clients have now been removed. Historical Perplexity and OpenRouter/Exa real calls succeeded. Cloudflare OAuth access is available. D1 and queues are provisioned; publication awaits explicit authorization to export the application/provider secrets after automatic approval review rejected that upload.

The user additionally requested files below 1,000 lines and at most ten files per source/test folder. Biome enforces 999 lines; the companion structure check runs inside `pnpm lint` and CI. Root configuration files are exempt by explicit user choice.

Final verification: `pnpm check` passes 182 deterministic tests plus lint (Biome and folder structure), strict typechecking, and all Turborepo builds. The complete Wrangler dry run also builds the Linux AMD64 production container successfully. Runtime/storage review confirms provider and shared-search authorization, late-result persistence, budget refusal, and lease recovery. That verification preceded the Cloudflare-native persistence change. The follow-up design and current deployment status are tracked in [cloudflare-storage.md](cloudflare-storage.md).

## Provider and style follow-up

`pnpm check` passes 307 deterministic tests, strict typechecking, lint/structure/style checks, and all builds after the provider refactor. A real authenticated HTTP MCP client selected two inline models through the generic SDK gateway and shared exactly one Exa retrieval; provider traffic used localhost fixtures. No presets or code edits were needed for those selections. Metadata resolvers preserve caller model/search/limits and explicit serving-provider pins.

Individual provider files are registered in `opensenpai.config.mjs`; custom SDK factories require no core workflow edits. Default presets are empty. JSDoc is required for public exports, and adjacent function/method implementations use one blank line; `pnpm format` repairs spacing, while `pnpm lint` checks both rules. Native execution telemetry remains unverified live. The later filtering clarification removes the separate-workspace/key requirement.

The updated real external agent also passed all seven tools over stdio with an inline `openrouter` / `openai/gpt-6-luna` selection and controlled Exa retrieval: one successful observation, three sources, application-reported spend $0.007280025. Report: ignored `.artifacts/real-agent/e2e-1792293004529-8122.report.json`. Conservative cumulative accounting is $9.243736, including the full $1 agent allowance and application estimate; no further paid calls are planned.

Final review fixes preserve accepted-run idempotency across catalog/credential changes, retain partial multi-query retrieval evidence and uncertain-charge reservations, and settle pre-dispatch cancellation with known zero model usage. Real Miniflare Durable Object/D1 tests verify accepted-run lookup/replay after restart even when presets and provider credentials are unavailable. The complete Cloudflare dry run builds the updated Linux AMD64 production image and Worker successfully; nothing was published.

## Native request filtering clarification

Native search now uses the ordinary OpenRouter key unless the operator explicitly selects another key in the OpenRouter provider file. No separate workspace or policy declaration is required. Endpoint capability filtering, route pinning, and the execution-time capability recheck stay entirely within the OpenRouter adapter. Unsupported/unknown native combinations fail before generation, while explicitly selected Exa remains valid. The post-response search proof guard remains in place; no new paid verification calls are needed for this change.

Verification for this clarification: `pnpm check` passes 322 tests plus lint, typechecking, and builds. Fifteen OpenRouter preflight regressions cover ordinary-key routing, malformed capability data, endpoint capability loss, explicit Exa, inactive endpoints, catalog outages, and model mismatches. Read-only live metadata checks reject GPT-4o/native and allow GPT-6 Luna/native, GLM 5.3 Flash/controlled Exa, and GPT-4o/server Exa. These checks issue zero paid requests.

## Customer-question HTTP agent exercise

The user requested a new end-to-end exercise with a running HTTP server and real OpenRouter credentials, using three questions from their customer-question bank. The first run crossed GLM/controlled Exa, Gemini/native, and Haiku/native for nine observations. The agent used all seven MCP tools and confirmed GPT-4o/native is rejected before dispatch. The experiment exposed an invalid GLM reasoning setting, an upstream Gemini HTTP 429, and valid Haiku native-search response metadata being rejected because generation analytics returned 404. One Haiku response was empty after exhausting its output budget; another was truncated. No provider fallback or paid automatic retry was introduced.

The OpenRouter verifier now accepts complete first-party response proof when analytics are unavailable, while requiring executed-search counters and rejecting conflicting identities or engines. Twelve new regressions and offline replay of the three real Haiku responses validate the fix: two retained answers verify as native; the empty answer stays rejected, and the truncated answer retains its warning and cost. `pnpm check` passes 334 tests.

Conservative accounting reached $10.0042994 after the first run. The user explicitly authorized raising the cumulative dispatch limit to $12 for the corrected run, retaining the original $15 overall cap. The corrected nine-observation manifest uses reasoning-compatible settings, larger output budgets, and a pinned Gemini Vertex endpoint, with an estimated application cost of $0.222503718 and reserved agent/application allowances of $0.75/$0.40. Raw/redacted reports and the customer question data stay in ignored `.artifacts/real-agent/`.

The corrected live HTTP exercise passed: all nine observations succeeded, all seven MCP tools were called by the real external agent, and unsupported GPT-4o/native was rejected before dispatch. GLM 5.3 Flash used controlled Exa; Gemini 3.8 Flash and Claude Haiku 5.5 each proved exactly one native search per observation. There were no substitutions, automatic paid retries, truncation warnings, or acceptance errors. Report: ignored `.artifacts/real-agent/e2e-1792295039235-35339.report.json`; durable run `e64f401f-272f-4c2d-b262-26ffbbd8c3c3`.

Reported costs were $0.104563312 for the application and $0.4456048 for the agent. Conservative cumulative accounting is $10.976803118 after retaining the full agent allowance and the higher application estimate. No further paid dispatch is needed. In this unbranded three-question sample, only Gemini's HIFLD answer mentioned Fulton Ring; following its answer link confirmed HTTP 200 at `https://fultonring.com/work/hifld-next/`. That link appeared in answer text, while the provider's structured citation list omitted it. Controlled Exa supplied three retrieved sources per question but no structured model citations, so retrieved visibility and answer attribution must remain distinct. Execution success does not grade factual accuracy or adherence to the requested 120-word limit.
