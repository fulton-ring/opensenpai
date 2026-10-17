import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, expect, it } from "vitest";
import {
  type ExecutionHooks,
  type ProviderResult,
  type RetrievalBundle,
  runInputSchema,
  type SpendAuthorization,
  targetSchema,
  type Usage,
} from "../src/contracts.js";
import { createRuntime, type RuntimeOptions } from "../src/runtime/index.js";
import { ResearchStore } from "../src/storage/index.js";

const resources: {
  store: ResearchStore;
  runtime: ReturnType<typeof createRuntime>;
  directory: string;
}[] = [];
afterEach(async () => {
  for (const value of resources.splice(0)) {
    await value.runtime.stop();
    await value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
const usage: Usage = {
  input_tokens: 1,
  output_tokens: 1,
  reasoning_tokens: null,
  cached_tokens: null,
  search_requests: 0,
  estimated_cost_usd: 0.01,
  reported_cost_usd: 0.01,
  raw: {},
};
const result: ProviderResult = {
  answer: "answer",
  requested_model: "mock",
  model: "mock",
  serving_provider: null,
  response_id: null,
  finish_reason: "stop",
  sources: [],
  citations: [],
  extracted_urls: [],
  search_activity: { requested: "controlled", observed: "executed", engine: "exa" },
  usage,
  raw_response: {},
  warnings: [],
};
async function setup(hooks: ExecutionHooks, options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-hooks-"));
  const store = new ResearchStore(
    createClient({ url: `file:${join(directory, "test.db")}` }),
    "test",
  );
  await store.initialize();
  const targets = ["one", "two"].map((id) =>
    targetSchema.parse({
      id,
      transport: "openai",
      model: "mock",
      search: { mode: "controlled", engine: "exa", max_results: 3, max_characters: 100 },
    }),
  );
  const input = runInputSchema.parse({
    prompts: [{ id: "p", text: "Question?", queries: ["first", "second"] }],
    targets: ["one", "two"],
    idempotency_key: "hooks",
  });
  await store.createRun(input, targets, {
    total_observations: 2,
    estimated_cost_usd: 0.06,
    retrieval_estimated_cost_usd: 0.04,
    unpriced_targets: [],
    observations: targets.map((t) => ({
      prompt_id: "p",
      target_id: t.id,
      repetition: 0,
      estimated_cost_usd: 0.01,
    })),
  });
  let retrievalCalls = 0;
  let providerCalls = 0;
  const runtime = createRuntime({
    store,
    role: "all",
    directOnly: true,
    env: {},
    storage: new LibSQLStore({ id: "hooks", url: ":memory:" }),
    hooks,
    retrieveExa: async ({ id, queries }): Promise<RetrievalBundle> => {
      retrievalCalls++;
      return {
        id,
        queries,
        context: "retrieved",
        sources: [],
        raw_response: {},
        estimated_cost_usd: 0.04,
        reported_cost_usd: 0.031,
        created_at: new Date().toISOString(),
      };
    },
    executeProvider: async () => {
      providerCalls++;
      return result;
    },
    ...options,
  });
  resources.push({ store, runtime, directory });
  const observations = await store.listPending();
  return {
    store,
    runtime,
    observations,
    retrievalCalls: () => retrievalCalls,
    providerCalls: () => providerCalls,
  };
}
it("denies retrieval before any Exa or provider call", async () => {
  const authorized: SpendAuthorization[] = [];
  const f = await setup({
    authorize: async (attempt) => {
      authorized.push(attempt);
      throw new Error("insufficient funds");
    },
  });
  await Promise.all(f.observations.map((o) => f.runtime.executeObservation(o.id)));
  expect(f.retrievalCalls()).toBe(0);
  expect(f.providerCalls()).toBe(0);
  expect(authorized).toHaveLength(1);
  expect((await f.store.getRun(f.observations[0]?.run_id ?? ""))?.reserved_cost_usd).toBe(0);
  expect(authorized[0]).toMatchObject({ operation: "retrieval", estimated_cost_usd: 0.04 });
});
it("authorizes and settles one shared retrieval with its actual cost and query count", async () => {
  const authorized: SpendAuthorization[] = [];
  const settled: { attempt: SpendAuthorization; outcome: string; usage: Usage | null }[] = [];
  const f = await setup({
    authorize: async (attempt) => {
      authorized.push(attempt);
    },
    settled: async (attempt, outcome, usage) => {
      settled.push({ attempt, outcome, usage });
    },
  });
  await Promise.all(f.observations.map((o) => f.runtime.executeObservation(o.id)));
  expect((await f.store.getObservation(f.observations[0]?.id ?? ""))?.error).toBeNull();
  expect(f.retrievalCalls()).toBe(1);
  expect(f.providerCalls()).toBe(2);
  const retrievalAuthorizations = authorized.filter((a) => a.operation === "retrieval");
  expect(retrievalAuthorizations).toHaveLength(1);
  const retrievalSettlements = settled.filter((s) => s.attempt.operation === "retrieval");
  expect(retrievalSettlements).toHaveLength(1);
  expect(retrievalSettlements[0]).toMatchObject({
    outcome: "succeeded",
    usage: { search_requests: 2, estimated_cost_usd: 0.04, reported_cost_usd: 0.031 },
  });
  const observation = await f.store.getObservation(f.observations[0]?.id ?? "");
  expect(retrievalAuthorizations[0]?.attempt_id).toBe(observation?.retrieval_id);
  expect(authorized.filter((a) => a.operation !== "retrieval")).toHaveLength(2);
});
it("retains a shared bundle when retrieval settlement hooks throw", async () => {
  const errors: unknown[] = [];
  const f = await setup(
    {
      settled: async (attempt) => {
        if (attempt.operation === "retrieval") throw new Error("wallet unavailable");
      },
    },
    { onError: (error) => errors.push(error) },
  );
  await Promise.all(f.observations.map((o) => f.runtime.executeObservation(o.id)));
  expect(errors).toHaveLength(1);
  expect(f.retrievalCalls()).toBe(1);
  expect(f.providerCalls()).toBe(2);
  expect((await f.store.getObservation(f.observations[0]?.id ?? ""))?.status).toBe("succeeded");
});
it("settles an ambiguous retrieval once with unknown usage and no paid retry", async () => {
  const settled: { attempt: SpendAuthorization; outcome: string; usage: Usage | null }[] = [];
  let calls = 0;
  const f = await setup(
    {
      settled: async (attempt, outcome, usage) => {
        settled.push({ attempt, outcome, usage });
      },
    },
    {
      retrieveExa: async () => {
        calls++;
        throw new Error("network outcome unknown");
      },
    },
  );
  await Promise.all(f.observations.map((o) => f.runtime.executeObservation(o.id)));
  expect(calls).toBe(1);
  expect(settled.filter((s) => s.attempt.operation === "retrieval")).toMatchObject([
    { outcome: "unknown_outcome", usage: null },
  ]);
});
it("reconciles a late retrieval with the same spend authorization after timeout", async () => {
  const authorizations: SpendAuthorization[] = [];
  const outcomes: { attempt: SpendAuthorization; outcome: string; usage: Usage | null }[] = [];
  let complete!: (value: RetrievalBundle) => void;
  let id = "";
  let queries: string[] = [];
  let calls = 0;
  const f = await setup(
    {
      authorize: async (attempt) => {
        authorizations.push(attempt);
      },
      settled: async (attempt, outcome, usage) => {
        outcomes.push({ attempt, outcome, usage });
      },
    },
    {
      timeoutMs: 20,
      retrieveExa: async (input) => {
        id = input.id;
        queries = input.queries;
        calls++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    },
  );
  await Promise.all(f.observations.map((o) => f.runtime.executeObservation(o.id)));
  complete({
    id,
    queries,
    context: "late paid bundle",
    sources: [],
    raw_response: {},
    estimated_cost_usd: 0.04,
    reported_cost_usd: 0.031,
    created_at: new Date().toISOString(),
  });
  for (
    let i = 0;
    i < 100 &&
    !outcomes.some((s) => s.attempt.operation === "retrieval" && s.outcome === "succeeded");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBe(1);
  expect(authorizations.filter((a) => a.operation === "retrieval")).toHaveLength(1);
  const retrievalOutcomes = outcomes.filter((s) => s.attempt.operation === "retrieval");
  expect(retrievalOutcomes.map((s) => s.outcome)).toEqual(["unknown_outcome", "succeeded"]);
  expect(retrievalOutcomes[1]).toMatchObject({
    attempt: { attempt_id: id },
    usage: { reported_cost_usd: 0.031, search_requests: 2 },
  });
});
