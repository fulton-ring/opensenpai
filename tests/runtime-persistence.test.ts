import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ProviderResult,
  type RetrievalBundle,
  runInputSchema,
  targetSchema,
} from "../src/contracts.js";
import { createRuntime } from "../src/runtime/index.js";
import { ResearchStore } from "../src/storage/index.js";

const result: ProviderResult = {
  answer: "paid answer",
  requested_model: "mock",
  model: "mock",
  serving_provider: null,
  response_id: "paid",
  finish_reason: "stop",
  sources: [],
  citations: [],
  extracted_urls: [],
  search_activity: { requested: "off", observed: "not_observed", engine: null },
  usage: {
    input_tokens: 1,
    output_tokens: 2,
    reasoning_tokens: null,
    cached_tokens: null,
    search_requests: 0,
    reported_cost_usd: 0.01,
    estimated_cost_usd: 0.01,
    raw: {},
  },
  raw_response: { paid: true },
  warnings: [],
};
const stores: ResearchStore[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
async function fixture(controlled = false) {
  const store = new ResearchStore(createClient({ url: "file::memory:" }), "test");
  stores.push(store);
  await store.initialize();
  const target = targetSchema.parse({
    id: "mock",
    transport: "openai",
    model: "mock",
    search: controlled
      ? { mode: "controlled", engine: "exa", max_results: 3, max_characters: 100 }
      : { mode: "off" },
  });
  const input = runInputSchema.parse({
    prompts: [{ id: "p", text: "Question?" }],
    targets: ["mock"],
    idempotency_key: "test",
  });
  const { run } = await store.createRun(input, [target], {
    total_observations: 1,
    estimated_cost_usd: 0.03,
    retrieval_estimated_cost_usd: controlled ? 0.02 : 0,
    unpriced_targets: [],
    observations: [{ prompt_id: "p", target_id: "mock", repetition: 0, estimated_cost_usd: 0.01 }],
  });
  const item = (await store.listPending())[0];
  if (!item) throw new Error("missing observation");
  let providerCalls = 0;
  let retrievalCalls = 0;
  const runtime = createRuntime({
    store,
    role: "all",
    env: {},
    directOnly: true,
    storage: new LibSQLStore({ id: "test-runtime", url: ":memory:" }),
    executeProvider: async () => {
      providerCalls++;
      return result;
    },
    retrieveExa: async ({ id, queries }): Promise<RetrievalBundle> => {
      retrievalCalls++;
      return {
        id,
        queries,
        context: "paid retrieval",
        sources: [],
        raw_response: { paid: true },
        reported_cost_usd: 0.015,
        estimated_cost_usd: 0.02,
        created_at: new Date().toISOString(),
      };
    },
  });
  runtimes.push(runtime);
  return {
    store,
    runtime,
    item,
    run,
    providerCalls: () => providerCalls,
    retrievalCalls: () => retrievalCalls,
  };
}
it("retries only provider result persistence after a transient storage failure", async () => {
  const f = await fixture();
  vi.spyOn(f.store, "succeed").mockRejectedValueOnce(new Error("write unavailable"));
  await f.runtime.executeObservation(f.item.id);
  expect(f.providerCalls()).toBe(1);
  expect(await f.store.getObservation(f.item.id)).toMatchObject({ status: "succeeded", result });
});
it("retains paid answer and actual usage when completion writes keep failing", async () => {
  const f = await fixture();
  vi.spyOn(f.store, "succeed").mockRejectedValue(new Error("completion write unavailable"));
  await f.runtime.executeObservation(f.item.id);
  expect(f.providerCalls()).toBe(1);
  expect((await f.store.getObservation(f.item.id))?.result).toEqual(result);
  expect((await f.store.getRun(f.run.id))?.reported_cost_usd).toBe(0.01);
});
it("retries only retrieval bundle persistence after a transient storage failure", async () => {
  const f = await fixture(true);
  vi.spyOn(f.store, "finishRetrieval").mockRejectedValueOnce(new Error("write unavailable"));
  await f.runtime.executeObservation(f.item.id);
  expect(f.retrievalCalls()).toBe(1);
  expect(f.providerCalls()).toBe(1);
  const observation = await f.store.getObservation(f.item.id);
  expect((await f.store.getRetrieval(observation?.retrieval_id ?? ""))?.bundle?.context).toBe(
    "paid retrieval",
  );
});
it("retains paid retrieval evidence when completion writes keep failing", async () => {
  const f = await fixture(true);
  vi.spyOn(f.store, "finishRetrieval").mockRejectedValue(new Error("completion write unavailable"));
  await f.runtime.executeObservation(f.item.id);
  expect(f.retrievalCalls()).toBe(1);
  expect(f.providerCalls()).toBe(0);
  const observation = await f.store.getObservation(f.item.id);
  expect(
    (await f.store.getRetrieval(observation?.retrieval_id ?? ""))?.bundle?.reported_cost_usd,
  ).toBe(0.015);
});

it("recovers expired external API claims at startup without paid replay", async () => {
  const f = await fixture();
  await f.store.claim(f.item.id, "crashed", 1);
  const claimed = await f.store.getObservation(f.item.id);
  if (!claimed?.attempt_id) throw new Error("missing attempt");
  await f.store.markDispatched(f.item.id, claimed.attempt_id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const runtime = createRuntime({
    store: f.store,
    env: {},
    role: "api",
    dispatchMode: "external",
    directOnly: true,
    storage: new LibSQLStore({ id: "external", url: ":memory:" }),
    executeProvider: async () => {
      throw new Error("paid replay");
    },
  });
  runtimes.push(runtime);
  await runtime.start();
  expect((await f.store.getObservation(f.item.id))?.status).toBe("unknown_outcome");
});
it("recovers claims that expire after external API startup before direct execution", async () => {
  const f = await fixture();
  await f.store.claim(f.item.id, "crashed", 50);
  const claimed = await f.store.getObservation(f.item.id);
  if (!claimed?.attempt_id) throw new Error("missing attempt");
  await f.store.markDispatched(f.item.id, claimed.attempt_id);
  const runtime = createRuntime({
    store: f.store,
    env: {},
    role: "api",
    dispatchMode: "external",
    directOnly: true,
    storage: new LibSQLStore({ id: "external", url: ":memory:" }),
    executeProvider: async () => {
      throw new Error("paid replay");
    },
  });
  runtimes.push(runtime);
  await runtime.start();
  expect((await f.store.getObservation(f.item.id))?.status).toBe("running");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await runtime.executeObservation(f.item.id);
  expect((await f.store.getObservation(f.item.id))?.status).toBe("unknown_outcome");
});
