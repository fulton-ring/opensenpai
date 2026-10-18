import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, expect, it } from "vitest";
import {
  type ProviderResult,
  ResearchError,
  type SpendAuthorization,
  targetSchema,
  type Usage,
} from "../../src/contracts.js";
import type { ProviderRegistry } from "../../src/providers/types.js";
import { createRuntime } from "../../src/runtime/index.js";
import { ResearchService } from "../../src/service.js";
import { ResearchStore } from "../../src/storage/index.js";

const result: ProviderResult = {
  answer: "Plugin answer",
  requested_model: "custom-model",
  model: "custom-served-model",
  serving_provider: "custom-host",
  response_id: "custom-response",
  finish_reason: "stop",
  sources: [{ url: "https://example.com/evidence" }],
  citations: [{ url: "https://example.com/evidence" }],
  extracted_urls: [],
  search_activity: { requested: "controlled", observed: "executed", engine: "custom_search" },
  usage: {
    input_tokens: 20,
    output_tokens: 10,
    reasoning_tokens: null,
    cached_tokens: null,
    search_requests: 0,
    reported_cost_usd: 0.003,
    estimated_cost_usd: 0.004,
    raw: { custom: true },
  },
  raw_response: { custom: true },
  warnings: [],
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const store = new ResearchStore(createClient({ url: ":memory:" }), "plugins");
  await store.initialize();
  const authorized: SpendAuthorization[] = [];
  const settled: { operation?: string; outcome: string; usage: Usage | null }[] = [];
  const modelInputs: string[] = [];
  const searchInputs: unknown[] = [];
  const providers: ProviderRegistry = {
    models: {
      custom_model: {
        availability: (_target, { env }) => ({ available: env.CUSTOM_MODEL_KEY === "test" }),
        execute: async (input) => {
          modelInputs.push(input.retrieval?.context ?? "missing");
          return result;
        },
      },
    },
    retrievals: {
      custom_search: {
        availability: ({ env }) => ({ available: env.CUSTOM_SEARCH_KEY === "test" }),
        estimate: ({ queries, options }) => queries.length * Number(options?.price),
        retrieve: async (input) => {
          searchInputs.push(input);
          return {
            id: input.id,
            queries: input.queries,
            context: "Plugin evidence",
            sources: result.sources,
            raw_response: { custom: true },
            reported_cost_usd: 0.13,
            estimated_cost_usd: 0.14,
            created_at: new Date().toISOString(),
          };
        },
      },
    },
  };
  const env = { CUSTOM_MODEL_KEY: "test", CUSTOM_SEARCH_KEY: "test" };
  const runtime = createRuntime({
    store,
    providers,
    env,
    role: "api",
    dispatchMode: "external",
    storage: new LibSQLStore({ id: "plugins", url: ":memory:" }),
    hooks: {
      authorize: async (attempt) => {
        authorized.push(attempt);
        if (attempt.operation === "retrieval")
          expect((await store.getRun(attempt.run_id))?.reserved_cost_usd).toBeGreaterThanOrEqual(
            0.14,
          );
      },
      settled: async (attempt, outcome, usage) => {
        settled.push({ operation: attempt.operation, outcome, usage });
      },
    },
  });
  const targets = ["first", "second"].map((id) =>
    targetSchema.parse({
      id,
      transport: "custom_model",
      model: "custom-model",
      search: {
        mode: "controlled",
        engine: "custom_search",
        options: { price: 0.07, region: "UK" },
      },
      pricing: { input_per_million: 1, output_per_million: 1 },
    }),
  );
  const service = new ResearchService({
    store,
    runtime,
    targets,
    providers,
    env,
    dispatchMode: "external",
  });
  cleanup.push(async () => {
    await runtime.stop();
    await store.close();
  });
  return { store, runtime, service, providers, authorized, settled, searchInputs, modelInputs };
}
const input = {
  prompts: [{ id: "p", text: "Question?", queries: ["first query", "second query"] }],
  targets: ["first", "second"],
  idempotency_key: "custom-provider",
  max_estimated_cost_usd: 1,
};
it("uses one registry for custom model availability, search estimation, durable execution and results", async () => {
  const f = await fixture();
  expect((await f.service.listTargets()).targets.every((target) => target.available)).toBe(true);
  expect((await f.service.estimateRun(input)).retrieval_estimated_cost_usd).toBeCloseTo(0.14);
  const { run } = await f.service.startRun(input);
  const pending = await f.store.listPending();
  await Promise.all(pending.map(({ id }) => f.runtime.executeObservation(id)));
  expect((await f.service.getRun({ run_id: run.id, wait_ms: 0 })).status).toBe("succeeded");
  expect(f.searchInputs).toHaveLength(1);
  expect(f.searchInputs[0]).toMatchObject({
    engine: "custom_search",
    options: { price: 0.07, region: "UK" },
  });
  expect(f.modelInputs).toEqual(["Plugin evidence", "Plugin evidence"]);
  expect(f.authorized.filter(({ operation }) => operation === "retrieval")).toMatchObject([
    { estimated_cost_usd: 0.14 },
  ]);
  expect((await f.service.getResults({ run_id: run.id, include_raw: true })).observations).toEqual(
    expect.arrayContaining([expect.objectContaining({ result })]),
  );
  expect((await f.store.getRun(run.id))?.reported_cost_usd).toBeCloseTo(0.136);
  expect((await f.store.getRun(run.id))?.reserved_cost_usd).toBe(0);
});
it("rejects a custom search adapter's unavailable credentials before creating paid work", async () => {
  const f = await fixture();
  f.service.options.env.CUSTOM_SEARCH_KEY = "";
  await expect(f.service.startRun(input)).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
  expect(await f.store.listRuns()).toEqual([]);
  expect(f.authorized).toEqual([]);
});
it("settles strict preflight rejection as known zero without calling or retrying a model", async () => {
  const f = await fixture();
  let calls = 0;
  Object.assign(f.providers.models, {
    custom_model: {
      availability: () => ({ available: true }),
      execute: async () => {
        calls++;
        throw new ResearchError(
          "provider_not_dispatched",
          "Native search policy rejected preflight",
        );
      },
    },
  });
  const { run } = await f.service.startRun({ ...input, targets: ["first"] });
  const [observation] = await f.store.listPending();
  if (!observation) throw new Error("Expected observation");
  await f.runtime.executeObservation(observation.id);
  await f.runtime.executeObservation(observation.id);
  expect(calls).toBe(1);
  expect((await f.store.getObservation(observation.id))?.status).toBe("failed");
  expect((await f.store.getRun(run.id))?.reserved_cost_usd).toBe(0);
  expect(f.settled.find(({ operation }) => operation === "model")).toMatchObject({
    outcome: "failed",
    usage: { reported_cost_usd: 0, estimated_cost_usd: 0, search_requests: 0 },
  });
});
it("retains billable search-proof failures and their evidence without a paid retry", async () => {
  const f = await fixture();
  let calls = 0;
  Object.assign(f.providers.models, {
    custom_model: {
      availability: () => ({ available: true }),
      execute: async () => {
        calls++;
        throw Object.assign(
          new ResearchError("search_unverified", "Search engine was unverified"),
          {
            result,
          },
        );
      },
    },
  });
  const { run } = await f.service.startRun({ ...input, targets: ["first"] });
  const [observation] = await f.store.listPending();
  if (!observation) throw new Error("Expected observation");
  await f.runtime.executeObservation(observation.id);
  await f.runtime.executeObservation(observation.id);
  expect(calls).toBe(1);
  expect((await f.store.getObservation(observation.id))?.result).toEqual(result);
  expect((await f.store.getRun(run.id))?.reported_cost_usd).toBeCloseTo(0.133);
  expect(f.settled.find(({ operation }) => operation === "model")).toMatchObject({
    outcome: "unknown_outcome",
    usage: result.usage,
  });
});
