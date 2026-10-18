import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { ResearchError, targetSchema } from "../../src/contracts.js";
import { ResearchService } from "../../src/service.js";
import { ResearchStore } from "../../src/storage/index.js";

it("gates new runs before persistence and replays accepted runs without billing or catalog checks", async () => {
  const store = new ResearchStore(createClient({ url: "file::memory:" }), "workspace");
  await store.initialize();
  let denied = true;
  let calls = 0;
  const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "fixture" };
  const service = new ResearchService({
    store,
    env,
    dispatchMode: "external",
    runtime: { dispatch: async () => {}, cancel: async () => {} },
    targets: [
      targetSchema.parse({
        id: "test",
        transport: "openrouter",
        model: "fixture",
        search: { mode: "off" },
        pricing: { input_per_million: 1, output_per_million: 1 },
      }),
    ],
    authorizeRun: async () => {
      calls++;
      if (denied) throw new ResearchError("INSUFFICIENT_CREDITS", "Add credits.");
    },
  });
  const input = {
    prompts: [{ id: "p", text: "hello" }],
    targets: ["test"],
    idempotency_key: "same",
  };
  try {
    await expect(service.startRun(input)).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(await store.getRunByIdempotencyKey("same")).toBeNull();
    denied = false;
    const first = await service.startRun(input);
    denied = true;
    env.OPENROUTER_API_KEY = undefined;
    const replay = await service.startRun(input);
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.created).toBe(false);
    expect(calls).toBe(2);
  } finally {
    await store.close();
  }
});
