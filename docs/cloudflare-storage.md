# Cloudflare-native persistence

The hosted profile uses Cloudflare databases. Research records live in the existing Container Durable Object's durable SQLite storage. Mastra workflow metadata uses its official D1 adapter. Local and split Docker profiles retain libSQL.

Research mutations currently perform dependent reads and writes inside a transaction. Durable Object SQLite supports these asynchronous transaction callbacks, so it can reuse the existing research store and its claiming, budget, idempotency, and reconciliation rules. D1 uses atomic batches instead of interactive transactions; it fits Mastra's native D1 adapter without rewriting the research state machine.

The Node container accesses both stores through private outbound host handlers. One handler calls workspace-scoped research methods on the owning Durable Object; another provides prepared queries through the D1 binding. Public Worker ingress never routes either handler. The container receives no Cloudflare account API token and keeps no authoritative database on its ephemeral filesystem.

## Implementation

- [x] Add a narrow SQL client/transaction injection boundary to the shared research store; implement Cloudflare SQL cursor conversion and transaction-backed RPC dispatch using real Durable Object storage.
- [x] Add Node clients for the private research and D1 endpoints; select them with `STORAGE_BACKEND=cloudflare` and instantiate Mastra's native `D1Store` with its binding-compatible client.
- [x] Bind a D1 database, wire the private outbound handlers, remove remote libSQL requirements from the Cloudflare adapter, and retain authenticated MCP ingress and bounded queue execution.
- [x] Test rollback, concurrent claims, idempotency, cancellation, reservations, immutable evidence, private routing, and persistence across container restart.
- [x] Finish repository checks and the complete Cloudflare image build.
- [ ] Publish and verify the hosted service after explicit approval to upload its secrets.

The authenticated CLI provisioned `opensenpai-mastra` and the observation/dead-letter queues. Automatic approval review rejected the secret upload because exporting the existing credentials to Cloudflare requires explicit permission. The rejected upload contained the two app authentication tokens and OpenRouter, Exa, and Perplexity keys; no values were printed and no credentials were uploaded.

`pnpm check` passes 231 tests, Biome and source/test folder limits, strict typechecking, and all Turborepo builds. The Miniflare test uses real Durable Object SQLite and D1: a trigger aborts the observation update after a reservation insert, proving the earlier write rolls back; concurrent claim calls produce one reservation. It then restarts the runtime and Node application to verify workflow snapshots, audit records, reservations, settled costs, and immutable result evidence survive. Provider responses in this deterministic persistence test are fixtures; it makes no paid calls. Earlier real-agent acceptance exercised the local HTTP and stdio transports with live providers.

The complete Wrangler dry run also passes, including the Linux AMD64 production image build and the Worker bundle with native D1 and Durable Object bindings. TypeScript compilation runs on the builder's native architecture; production dependencies still use the target architecture.

## Guardrails

The MCP surface and external-agent scheduling model stay unchanged. Generic paid retries remain disabled. All source files stay below 1,000 lines, and each source/test directory contains at most ten files. Existing local observations are retained in their libSQL files; no previously deployed hosted database requires migration because the remote-libSQL profile was never published.
