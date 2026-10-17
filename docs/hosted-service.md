# Hosted service boundary

The open-source core executes research and records evidence. The shipped Cloudflare deployment serves one operator workspace using bearer authentication and BYOK credentials. It is not yet a customer billing service.

A paid deployment can keep the same seven MCP tools and research workflows. Its additional responsibilities are:

1. Authenticate the customer and resolve a trusted workspace. Never accept the workspace identity directly from tool arguments or an unverified header.
2. Accept prepaid purchases through a payment provider. Verify webhook signatures and apply each payment event once to an append-only credit ledger.
3. Supply execution hooks that atomically reserve credits before a model or shared retrieval operation. Use the operation's stable attempt ID as the idempotency key.
4. Settle the reservation using immutable usage records and a versioned customer price. Refund unused reservations only when the outcome is known. Retain holds for ambiguous outcomes until reconciliation.
5. Apply account rate limits and spending policies, and provide balance, purchase history, and usage views.

Use integer credit units for the wallet. Research records distinguish provider-reported dollars, estimates, and unknown costs; those records are evidence for billing rather than a complete financial ledger. Repeated settlement notifications must reconcile the same attempt rather than create a second charge.

Storage queries and run idempotency are workspace-scoped. The current CLI constructs one workspace-bound store and service. A hosted identity layer must construct or select the correct workspace-bound service after authentication. The supplied Cloudflare Worker currently routes to one named container; customer routing and account provisioning must be added before offering shared paid hosting.

Workers handle authentication, MCP ingress, queue delivery, and purchase webhooks. Containers run the native Node/Mastra application. Remote libSQL stores durable research state and can also host the separate wallet tables. Queues contain observation IDs, never prompts or provider credentials. Existing compare-and-set claims prevent duplicate delivery from repeating a paid operation.

Research scheduling stays with the customer's agent. Infrastructure repair only recovers and dispatches previously accepted work.
