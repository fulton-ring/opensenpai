import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ExecutionHooks,
  type ProviderResult,
  type RetrievalBundle,
  runInputSchema,
  type SpendAuthorization,
  targetSchema,
  type Usage,
} from "../src/contracts.js";
import { retrieveSearch } from "../src/providers/index.js";
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

it("settles model authorization followed by cancellation as known zero before dispatch", async () => {
  const settled: { attempt: SpendAuthorization; outcome: string; usage: Usage | null }[] = [];
  let cancel: (id: string) => Promise<unknown> = async () => undefined;
  const f = await setup({
    authorize: async (attempt) => {
      if (attempt.operation === "model") await cancel(attempt.run_id);
    },
    settled: async (attempt, outcome, usage) => {
      settled.push({ attempt, outcome, usage });
    },
  });
  cancel = (id) => f.store.cancelRun(id);
  const observation = f.observations[0];
  if (!observation) throw new Error("Expected observation");
  await f.runtime.executeObservation(observation.id);
  expect(f.providerCalls()).toBe(0);
  expect((await f.store.getObservation(observation.id))?.status).toBe("cancelled");
  expect((await f.store.getRun(observation.run_id))?.reserved_cost_usd).toBe(0);
  expect(settled.find(({ attempt }) => attempt.operation === "model")).toMatchObject({
    outcome: "cancelled",
    usage: { reported_cost_usd: 0, estimated_cost_usd: 0, input_tokens: 0, search_requests: 0 },
  });
});

it("retains unknown settlement when the dispatch marker commits but its response is lost", async () => {
  const settled: { attempt: SpendAuthorization; outcome: string; usage: Usage | null }[] = [];
  const f = await setup({
    settled: async (attempt, outcome, usage) => {
      settled.push({ attempt, outcome, usage });
    },
  });
  const markDispatched = f.store.markDispatched.bind(f.store);
  vi.spyOn(f.store, "markDispatched").mockImplementation(async (...args) => {
    await markDispatched(...args);
    throw new Error("Dispatch commit acknowledgement lost");
  });
  const observation = f.observations[0];
  if (!observation) throw new Error("Expected observation");
  await f.runtime.executeObservation(observation.id);
  expect(f.providerCalls()).toBe(0);
  expect((await f.store.getObservation(observation.id))?.status).toBe("unknown_outcome");
  expect((await f.store.getRun(observation.run_id))?.reserved_cost_usd).toBe(0.01);
  expect(settled.find(({ attempt }) => attempt.operation === "model")).toMatchObject({
    outcome: "unknown_outcome",
    usage: null,
  });
});

it.each([false, true])(
  "persists completed search evidence when a later query is ambiguous=%s",
  async (unknown) => {
    const settled: { attempt: SpendAuthorization; outcome: string; usage: Usage | null }[] = [];
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1)
        return Response.json({
          results: [
            { url: "https://example.com/evidence", title: "Evidence", text: "Paid evidence" },
          ],
          costDollars: { total: 0.006 },
        });
      if (unknown) throw new Error("Second query outcome unknown");
      return Response.json({ error: "rate limited" }, { status: 429 });
    };
    const f = await setup(
      {
        settled: async (attempt, outcome, usage) => {
          settled.push({ attempt, outcome, usage });
        },
      },
      {
        retrieveSearch: (input) =>
          retrieveSearch(input, { EXA_API_KEY: "test" }, { fetch: fetcher }),
      },
    );
    const observation = f.observations[0];
    if (!observation) throw new Error("Expected observation");
    await f.runtime.executeObservation(observation.id);
    await f.runtime.executeObservation(observation.id);
    const saved = await f.store.getObservation(observation.id);
    const retrieval = await f.store.getRetrieval(saved?.retrieval_id ?? "");
    expect(calls).toBe(2);
    expect(f.providerCalls()).toBe(0);
    expect(retrieval).toMatchObject({
      status: unknown ? "unknown_outcome" : "failed",
      bundle: {
        queries: ["first"],
        reported_cost_usd: unknown ? null : 0.006,
        sources: [{ url: "https://example.com/evidence" }],
        raw_response: { completed_reported_cost_usd: 0.006 },
      },
    });
    expect((await f.store.getRun(observation.run_id))?.reserved_cost_usd).toBe(unknown ? 0.04 : 0);
    expect(settled.find(({ attempt }) => attempt.operation === "retrieval")).toMatchObject({
      outcome: unknown ? "unknown_outcome" : "failed",
      usage: {
        reported_cost_usd: unknown ? null : 0.006,
        search_requests: unknown ? null : 1,
        raw: { completed_reported_cost_usd: 0.006 },
      },
    });
  },
);

it("retains partial retrieval evidence arriving after the abort race rejects first", async () => {
  const settled: { attempt: SpendAuthorization; outcome: string; usage: Usage | null }[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async (_request, init) => {
    calls++;
    if (calls === 1)
      return Response.json({
        results: [{ url: "https://example.com/first" }],
        costDollars: { total: 0.006 },
      });
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const f = await setup(
    {
      settled: async (attempt, outcome, usage) => {
        settled.push({ attempt, outcome, usage });
      },
    },
    {
      timeoutMs: 30,
      retrieveSearch: (input) => retrieveSearch(input, { EXA_API_KEY: "test" }, { fetch: fetcher }),
    },
  );
  const observation = f.observations[0];
  if (!observation) throw new Error("Expected observation");
  await f.runtime.executeObservation(observation.id);
  const saved = await f.store.getObservation(observation.id);
  for (let i = 0; i < 100 && !(await f.store.getRetrieval(saved?.retrieval_id ?? ""))?.bundle; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(calls).toBe(2);
  expect(f.providerCalls()).toBe(0);
  expect(await f.store.getRetrieval(saved?.retrieval_id ?? "")).toMatchObject({
    status: "unknown_outcome",
    bundle: {
      queries: ["first"],
      reported_cost_usd: null,
      raw_response: { completed_reported_cost_usd: 0.006 },
    },
  });
  expect((await f.store.getRun(observation.run_id))?.reserved_cost_usd).toBe(0.04);
  expect(settled.filter(({ attempt }) => attempt.operation === "retrieval")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        outcome: "unknown_outcome",
        usage: expect.objectContaining({
          reported_cost_usd: null,
          search_requests: null,
          raw: expect.objectContaining({ completed_reported_cost_usd: 0.006 }),
        }),
      }),
    ]),
  );
});
