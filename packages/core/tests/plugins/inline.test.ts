import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, expect, it } from "vitest";
import type { ProviderResult, Target } from "../../src/contracts.js";
import type { ProviderRegistry } from "../../src/providers/types.js";
import { createRuntime } from "../../src/runtime/index.js";
import { ResearchService } from "../../src/service.js";
import { ResearchStore } from "../../src/storage/index.js";

const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of resources.splice(0)) await close();
});
const inline = {
  id: "glm-research",
  provider: "compatible",
  model: "z-ai/glm-4.7",
  serving_provider: "dedicated",
  search: { mode: "controlled", engine: "exa" },
};
const input = {
  prompts: [{ id: "p", text: "Which commerce platforms support agents?" }],
  targets: [inline],
  idempotency_key: "inline-model",
  max_estimated_cost_usd: 1,
};
const result: ProviderResult = {
  answer: "Evidence-backed answer",
  requested_model: inline.model,
  model: inline.model,
  serving_provider: "dedicated",
  response_id: "response",
  finish_reason: "stop",
  sources: [],
  citations: [],
  extracted_urls: [],
  search_activity: { requested: "controlled", observed: "executed", engine: "exa" },
  usage: {
    input_tokens: 10,
    output_tokens: 10,
    cached_tokens: 0,
    reasoning_tokens: 0,
    search_requests: 0,
    estimated_cost_usd: 0.01,
    reported_cost_usd: 0.01,
    raw: {},
  },
  raw_response: {},
  warnings: [],
};
async function fixture() {
  const store = new ResearchStore(createClient({ url: ":memory:" }), "inline");
  await store.initialize();
  const resolved: Target[] = [];
  const generated: Target[] = [];
  const metadataQueries: unknown[] = [];
  let retrievals = 0;
  const providers: ProviderRegistry = {
    models: {
      compatible: {
        availability: () => ({ available: true }),
        resolveTarget: async (target) => {
          resolved.push(target);
          return {
            ...target,
            pricing: { input_per_million: 1, output_per_million: 1, search_per_request: 0 },
          };
        },
        listModels: async (query) => {
          metadataQueries.push(query);
          return [{ id: inline.model, name: "GLM" }];
        },
        execute: async ({ target, retrieval }) => {
          expect(retrieval?.context).toBe("Evidence");
          generated.push(target);
          return result;
        },
      },
    },
    retrievals: {
      exa: {
        availability: () => ({ available: true }),
        estimate: () => 0.02,
        retrieve: async ({ id, queries }) => {
          retrievals++;
          return {
            id,
            queries,
            context: "Evidence",
            sources: [],
            raw_response: {},
            estimated_cost_usd: 0.02,
            reported_cost_usd: 0.02,
            created_at: new Date().toISOString(),
          };
        },
      },
    },
  };
  const runtime = createRuntime({
    store,
    providers,
    env: {},
    role: "api",
    dispatchMode: "external",
    storage: new LibSQLStore({ id: "inline", url: ":memory:" }),
  });
  const service = new ResearchService({
    store,
    runtime,
    providers,
    targets: [],
    env: {},
    dispatchMode: "external",
  });
  resources.push(async () => {
    await runtime.stop();
    await store.close();
  });
  return {
    store,
    runtime,
    service,
    providers,
    resolved,
    generated,
    metadataQueries,
    retrievals: () => retrievals,
  };
}
it("selects an inline model and independent search through estimate, durable run and workflow without presets", async () => {
  const f = await fixture();
  const estimate = await f.service.estimateRun(input);
  expect(estimate.unpriced_targets).toEqual([]);
  expect(estimate.retrieval_estimated_cost_usd).toBe(0.02);
  const { run } = await f.service.startRun(input);
  const [observation] = await f.store.listPending();
  if (!observation) throw new Error("Expected inline observation");
  expect(observation.target).toMatchObject({
    id: inline.id,
    transport: "compatible",
    model: inline.model,
    search: inline.search,
    provider_options: { provider: "dedicated" },
  });
  await f.runtime.executeObservation(observation.id);
  expect((await f.service.getRun({ run_id: run.id, wait_ms: 0 })).status).toBe("succeeded");
  expect(f.resolved).toHaveLength(2);
  expect(f.generated).toHaveLength(1);
  expect(f.retrievals()).toBe(1);
  expect(
    (await f.service.getResults({ run_id: run.id, include_raw: true })).observations[0]?.result,
  ).toEqual(result);
});
it("discovers adapter choices without a model metadata request and filters models on demand", async () => {
  const f = await fixture();
  expect(await f.service.listTargets()).toMatchObject({
    targets: [],
    model_providers: ["compatible"],
    retrieval_providers: ["exa"],
  });
  expect(f.metadataQueries).toEqual([]);
  expect(
    await f.service.listTargets({ provider: "compatible", model_query: "glm", limit: 5 }),
  ).toMatchObject({ models: [{ id: inline.model, name: "GLM" }] });
  expect(f.metadataQueries).toEqual([{ query: "glm", limit: 5 }]);
  expect(f.generated).toEqual([]);
});
it("rejects unknown and inherited providers before metadata or paid operations", async () => {
  const f = await fixture();
  for (const provider of ["missing", "constructor"])
    await expect(
      f.service.startRun({ ...input, targets: [{ ...inline, provider }] }),
    ).rejects.toMatchObject({ code: "UNKNOWN_MODEL_PROVIDER" });
  await expect(f.service.listTargets({ provider: "constructor" })).rejects.toMatchObject({
    code: "UNKNOWN_MODEL_PROVIDER",
  });
  expect(f.resolved).toEqual([]);
  expect(f.metadataQueries).toEqual([]);
  expect(f.generated).toEqual([]);
  expect(f.retrievals()).toBe(0);
  expect(await f.store.listRuns()).toEqual([]);
});
it("rejects a budgeted model without trusted pricing before dispatch", async () => {
  const f = await fixture();
  Object.assign(f.providers.models, {
    compatible: { ...f.providers.models.compatible, resolveTarget: undefined },
  });
  expect((await f.service.estimateRun(input)).unpriced_targets).toEqual([inline.id]);
  await expect(f.service.startRun(input)).rejects.toMatchObject({ code: "UNPRICED_TARGET" });
  expect(f.generated).toEqual([]);
  expect(await f.store.listRuns()).toEqual([]);
});
it("rejects resolvers that silently change the requested model, adapter or search", async () => {
  const f = await fixture();
  const adapter = f.providers.models.compatible;
  for (const changes of [
    { model: "different-model" },
    { transport: "different" },
    { id: "different" },
    { search: { mode: "off" } },
  ]) {
    Object.assign(f.providers.models, {
      compatible: {
        ...adapter,
        resolveTarget: async (target: Target) => ({ ...target, ...changes }),
      },
    });
    await expect(f.service.startRun(input)).rejects.toMatchObject({
      code: "INVALID_TARGET_RESOLUTION",
    });
  }
  expect(f.generated).toEqual([]);
  expect(await f.store.listRuns()).toEqual([]);
});
