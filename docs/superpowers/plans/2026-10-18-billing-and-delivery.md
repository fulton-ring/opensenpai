# Durable billing and delivery fixes

Approved scope: retain provider charge evidence, reconcile incomplete usage without repeating paid work, deliver corrections safely, and investigate the observed five-minute delay before execution.

1. Add regression tests for malformed SDK responses that still contain billed usage. Preserve raw response IDs and charges; add an optional metadata-only provider reconciliation method, implemented by OpenRouter.
2. Persist unresolved accounting independently of observation status. Maintain immutable, monotonically revisioned usage and settlement evidence. Retry metadata lookup with bounded backoff; never substitute zero for unknown cost or replay generation/search.
3. Apply revisioned wallet settlements atomically, recording debit/refund adjustments. Older delivery cannot revert newer charges. Keep reservations for unknown costs.
4. Isolate settlement failures and avoid draining unrelated billing work on the execution critical path. Verify restart, duplicate delivery, concurrent correction, and poisoned-event behavior.
5. Trace initial queue delivery using safe diagnostics on the supplied run. Add credential-free stage timing where existing telemetry is insufficient. Preserve durable claim guards and the stale-delivery repair safety net.
6. Review specifications and code independently. Run both repositories' checks, publish PRs, wait for CI, merge, update the pinned public SDK, and deploy the private service from merged source. Verify native MCP connectivity and durable state without new paid research.

Public engine remains usable without managed billing. Provider-specific reconciliation stays in its adapter. Managed wallet and deployment stay private.
