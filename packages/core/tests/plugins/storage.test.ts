import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { runInputSchema, targetSchema } from "../../src/contracts.js";
import { ResearchStore } from "../../src/storage/index.js";

it("releases a known unbilled preflight reservation after the dispatch marker", async () => {
  const store = new ResearchStore(createClient({ url: "file::memory:" }));
  try {
    await store.initialize();
    const input = runInputSchema.parse({
      prompts: [{ id: "p", text: "question" }],
      targets: ["t"],
      idempotency_key: "preflight",
    });
    const target = targetSchema.parse({
      id: "t",
      transport: "openrouter",
      model: "test",
      search: { mode: "off" },
    });
    const { run } = await store.createRun(input, [target], {
      total_observations: 1,
      estimated_cost_usd: 0.1,
      retrieval_estimated_cost_usd: 0,
      unpriced_targets: [],
      observations: [{ prompt_id: "p", target_id: "t", repetition: 0, estimated_cost_usd: 0.1 }],
    });
    const [row] = (await store.getResults({ run_id: run.id })).observations;
    if (!row) throw new Error("Missing observation");
    const claim = await store.claim(row.id, "test");
    if (!claim?.attempt_id) throw new Error("Missing attempt");
    await store.markDispatched(row.id, claim.attempt_id);
    await store.fail(
      row.id,
      claim.attempt_id,
      { code: "provider_not_dispatched", message: "Endpoint unsupported", retryable: false },
      "failed",
    );
    expect(await store.getRun(run.id)).toMatchObject({
      reserved_cost_usd: 0,
      reported_cost_usd: 0,
    });
  } finally {
    await store.close();
  }
});
