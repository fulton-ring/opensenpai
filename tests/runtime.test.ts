import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { EventEmitterPubSub } from "@mastra/core/events";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Observation,
  ProviderResult,
  RetrievalBundle,
  RetrievalRecord,
  RunRecord,
} from "../src/contracts.js";
import { ResearchError, type RunEstimate, runInputSchema, targetSchema } from "../src/contracts.js";
import { createRuntime, type RuntimeStore } from "../src/runtime/index.js";
import { ResearchStore } from "../src/storage/index.js";

const result: ProviderResult = {
  answer: "answer",
  requested_model: "mock",
  model: "mock",
  serving_provider: null,
  response_id: "response",
  finish_reason: "stop",
  sources: [],
  citations: [],
  extracted_urls: [],
  search_activity: { requested: "off", observed: "not_observed", engine: null },
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    reasoning_tokens: null,
    cached_tokens: null,
    search_requests: 0,
    reported_cost_usd: 0.01,
    estimated_cost_usd: 0.01,
    raw: {},
  },
  raw_response: {},
  warnings: [],
};
function observation(
  id = "observation",
  search: Observation["target"]["search"] = { mode: "off" },
): Observation {
  return {
    id,
    workspace_id: "local",
    run_id: "run",
    ordinal: 0,
    prompt: { id: "prompt", text: "Question?" },
    target: {
      id,
      transport: "openai",
      model: "mock",
      search,
      max_output_tokens: 32,
      timeout_ms: 1000,
    },
    repetition: 0,
    locale: "en-US",
    status: "pending",
    attempt_id: null,
    owner: null,
    lease_until: null,
    dispatched_at: null,
    retrieval_id: null,
    estimated_cost_usd: 0.01,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
class Store implements RuntimeStore {
  observations = new Map<string, Observation>();
  retrievals = new Map<string, RetrievalRecord>();
  cancelled = false;
  recovered = 0;
  queued = new Set<string>();
  constructor(items = [observation()]) {
    for (const item of items) this.observations.set(item.id, item);
  }
  async getObservation(id: string) {
    return this.observations.get(id) ?? null;
  }
  async getRun() {
    return { cancel_requested: this.cancelled } as RunRecord;
  }
  async listPending() {
    return [...this.observations.values()].filter((o) => o.status === "pending");
  }
  async listUnqueued(limit = 100) {
    return (await this.listPending()).filter((o) => !this.queued.has(o.id)).slice(0, limit);
  }
  async markQueued(id: string) {
    this.queued.add(id);
  }
  async claim(id: string, owner: string) {
    const o = this.observations.get(id);
    if (o?.status !== "pending" || this.cancelled) return null;
    Object.assign(o, { status: "running", owner, attempt_id: `attempt-${id}` });
    return structuredClone(o);
  }
  async markDispatched(id: string) {
    if (this.cancelled) return false;
    Object.assign(this.observations.get(id) ?? {}, { dispatched_at: new Date().toISOString() });
    return true;
  }
  async succeed(id: string, _attempt: string, value: ProviderResult) {
    Object.assign(this.observations.get(id) ?? {}, { status: "succeeded", result: value });
  }
  async fail(
    id: string,
    _attempt: string,
    error: Observation["error"],
    status: "failed" | "unknown_outcome" | "cancelled" = "failed",
    partialResult?: ProviderResult,
  ) {
    Object.assign(this.observations.get(id) ?? {}, {
      status,
      error,
      result: partialResult ?? null,
    });
  }
  async cancelRun() {
    this.cancelled = true;
    for (const o of this.observations.values()) if (o.status === "pending") o.status = "cancelled";
  }
  async recoverExpired() {
    this.recovered++;
    for (const o of this.observations.values())
      if (o.status === "running") o.status = o.dispatched_at ? "unknown_outcome" : "pending";
  }
  async getRetrieval(id: string) {
    return this.retrievals.get(id) ?? null;
  }
  async claimRetrieval(id: string, _run: string, owner: string) {
    if (this.retrievals.has(id)) return false;
    this.retrievals.set(id, {
      id,
      status: "running",
      owner,
      lease_until: new Date(Date.now() + 10000).toISOString(),
      bundle: null,
      error: null,
    });
    return true;
  }
  async finishRetrieval(bundle: RetrievalBundle) {
    Object.assign(this.retrievals.get(bundle.id) ?? {}, { status: "succeeded", bundle });
  }
  async failRetrieval(id: string, _owner: string, error: Observation["error"], unknown = false) {
    Object.assign(this.retrievals.get(id) ?? {}, {
      status: unknown ? "unknown_outcome" : "failed",
      error,
    });
  }
}
const runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});
function runtime(store: Store, options: Partial<Parameters<typeof createRuntime>[0]> = {}) {
  const r = createRuntime({
    storage: new LibSQLStore({ id: "test-runtime", url: ":memory:" }),
    store,
    env: {},
    role: "all",
    executeProvider: async () => result,
    ...options,
  });
  runtimes.push(r);
  return r;
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("runtime native workflows", () => {
  it("executes a provider through a native workflow and awaits persistence", async () => {
    const store = new Store();
    const r = runtime(store);
    await r.executeObservation("observation");
    expect(store.observations.get("observation")?.result).toEqual(result);
    expect(r.mastra.getWorkflow("observationDirect")).toBeDefined();
  });
  it("dispatches through native in-process evented workers", async () => {
    const store = new Store();
    const r = runtime(store);
    await r.start();
    await until(() => store.observations.get("observation")?.status === "succeeded");
    expect(store.queued.has("observation")).toBe(true);
  });
  it("drains all startup outbox pages", async () => {
    const store = new Store(
      Array.from({ length: 101 }, (_value, i) => observation(`observation-${i}`)),
    );
    const r = runtime(store);
    await r.start();
    await until(() =>
      [...store.observations.values()].every((item) => item.status === "succeeded"),
    );
    expect(store.queued.size).toBe(101);
  });
  it("does not execute paid work in API role", async () => {
    let calls = 0;
    const store = new Store();
    const r = runtime(store, {
      role: "api",
      executeProvider: async () => {
        calls++;
        return result;
      },
    });
    await r.executeObservation("observation");
    expect(calls).toBe(0);
    expect(store.observations.get("observation")?.status).toBe("pending");
  });
  it("does not duplicate provider calls when dispatched concurrently", async () => {
    let calls = 0;
    const store = new Store();
    const r = runtime(store, {
      executeProvider: async () => {
        calls++;
        return result;
      },
    });
    await Promise.all([r.executeObservation("observation"), r.executeObservation("observation")]);
    expect(calls).toBe(1);
  });
  it("cancels pending observations before dispatch", async () => {
    let calls = 0;
    const store = new Store();
    const r = runtime(store, {
      executeProvider: async () => {
        calls++;
        return result;
      },
    });
    await r.cancel("run");
    await r.executeObservation("observation");
    expect(calls).toBe(0);
    expect(store.observations.get("observation")?.status).toBe("cancelled");
  });
  it("aborts active calls and records ambiguous dispatched outcomes", async () => {
    const store = new Store();
    let entered = false;
    let aborted = false;
    const r = runtime(store, {
      executeProvider: async ({ signal }) => {
        entered = true;
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    });
    const running = r.executeObservation("observation");
    await until(() => entered);
    await r.cancel("run");
    await running;
    expect(aborted).toBe(true);
    expect(store.observations.get("observation")?.status).toBe("unknown_outcome");
  });
  it("enforces a total execution deadline without retry", async () => {
    let calls = 0;
    const store = new Store();
    const r = runtime(store, {
      timeoutMs: 25,
      executeProvider: async ({ signal }) => {
        calls++;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    await r.executeObservation("observation");
    expect(calls).toBe(1);
    expect(store.observations.get("observation")?.error?.code).toBe("deadline_exceeded");
    expect(store.observations.get("observation")?.status).toBe("unknown_outcome");
  });
  it("recovers ambiguous claims without replaying the paid provider", async () => {
    let calls = 0;
    const o = observation();
    o.status = "running";
    o.dispatched_at = new Date().toISOString();
    const store = new Store([o]);
    const r = runtime(store, {
      executeProvider: async () => {
        calls++;
        return result;
      },
    });
    await r.start();
    await r.executeObservation(o.id);
    expect(store.recovered).toBe(1);
    expect(calls).toBe(0);
    expect(o.status).toBe("unknown_outcome");
  });
  it("retrieves one shared controlled bundle across targets", async () => {
    const search = {
      mode: "controlled",
      engine: "exa",
      max_results: 3,
      max_characters: 100,
    } as const;
    const store = new Store([observation("one", search), observation("two", search)]);
    let searches = 0;
    const bundles: string[] = [];
    const r = runtime(store, {
      retrieveExa: async ({ id, queries }) => {
        searches++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          id,
          queries,
          sources: [],
          context: "shared",
          raw_response: {},
          estimated_cost_usd: 0.01,
          reported_cost_usd: null,
          created_at: new Date().toISOString(),
        };
      },
      executeProvider: async (input) => {
        expect(input.retrieval).toBeDefined();
        bundles.push(input.retrieval?.id ?? "missing");
        return result;
      },
    });
    await Promise.all([r.executeObservation("one"), r.executeObservation("two")]);
    expect(searches).toBe(1);
    expect(new Set(bundles).size).toBe(1);
    expect(bundles).toHaveLength(2);
  });
  it("bounds a noncooperative provider and preserves late incurred usage", async () => {
    const store = new Store();
    let complete!: (r: ProviderResult) => void;
    const r = runtime(store, {
      timeoutMs: 25,
      executeProvider: async () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    const begin = Date.now();
    await r.executeObservation("observation");
    expect(Date.now() - begin).toBeLessThan(500);
    expect(store.observations.get("observation")?.status).toBe("unknown_outcome");
    complete(result);
    await until(() => store.observations.get("observation")?.status === "succeeded");
    expect(store.observations.get("observation")?.result?.usage.reported_cost_usd).toBe(0.01);
  });
  it("does not call the provider if cancellation wins the dispatch marker", async () => {
    const store = new Store();
    let calls = 0;
    store.markDispatched = async () => false;
    const r = runtime(store, {
      executeProvider: async () => {
        calls++;
        return result;
      },
    });
    await r.executeObservation("observation");
    expect(calls).toBe(0);
    expect(store.observations.get("observation")?.status).toBe("cancelled");
  });
  it("settles the persisted result after spend authorization", async () => {
    const store = new Store();
    const events: string[] = [];
    const r = runtime(store, {
      hooks: {
        authorize: async () => {
          events.push("authorize");
          expect(store.observations.get("observation")?.dispatched_at).toBeNull();
        },
        settled: async (_attempt, outcome) => {
          events.push(outcome);
          expect(store.observations.get("observation")?.status).toBe("succeeded");
        },
      },
      executeProvider: async () => {
        events.push("provider");
        return result;
      },
    });
    await r.executeObservation("observation");
    expect(events).toEqual(["authorize", "provider", "succeeded"]);
    const workflowStore = await r.mastra.getStorage()?.getStore("workflows");
    const snapshots = await workflowStore?.listWorkflowRuns({ workflowName: "observation-direct" });
    expect(snapshots?.runs.length).toBeGreaterThan(0);
  });
  it("shares one total deadline across controlled retrieval and provider", async () => {
    const store = new Store([
      observation("observation", {
        mode: "controlled",
        engine: "exa",
        max_results: 3,
        max_characters: 100,
      }),
    ]);
    let providerStarted = 0;
    let providerEnded = 0;
    const r = runtime(store, {
      timeoutMs: 100,
      retrieveExa: async ({ id, queries }) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          id,
          queries,
          sources: [],
          context: "shared",
          raw_response: {},
          estimated_cost_usd: 0.02,
          reported_cost_usd: null,
          created_at: new Date().toISOString(),
        };
      },
      executeProvider: async ({ signal }) => {
        providerStarted = Date.now();
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              providerEnded = Date.now();
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    });
    await r.executeObservation("observation");
    expect(providerStarted).toBeGreaterThan(0);
    expect(providerEnded - providerStarted).toBeLessThan(85);
    expect(store.observations.get("observation")?.status).toBe("unknown_outcome");
  });
  it("runs producer API events using a separately registered worker runtime", async () => {
    const store = new Store([]);
    const pubsub = new EventEmitterPubSub();
    const storage = new LibSQLStore({ id: "split-test", url: ":memory:" });
    let apiCalls = 0;
    let workerCalls = 0;
    const api = runtime(store, {
      role: "api",
      pubsub,
      storage,
      executeProvider: async () => {
        apiCalls++;
        return result;
      },
    });
    const worker = runtime(store, {
      role: "worker",
      pubsub,
      storage,
      executeProvider: async () => {
        workerCalls++;
        return result;
      },
    });
    await worker.start();
    store.observations.set("observation", observation());
    await api.start();
    await until(() => store.observations.get("observation")?.status === "succeeded");
    expect(apiCalls).toBe(0);
    expect(workerCalls).toBe(1);
  });
  it("bounds noncooperative retrieval and preserves its late cost without starting a provider", async () => {
    const store = new Store([
      observation("observation", {
        mode: "controlled",
        engine: "exa",
        max_results: 3,
        max_characters: 100,
      }),
    ]);
    let complete!: (r: RetrievalBundle) => void;
    let providerCalls = 0;
    const r = runtime(store, {
      timeoutMs: 25,
      retrieveExa: async () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      executeProvider: async () => {
        providerCalls++;
        return result;
      },
    });
    await r.executeObservation("observation");
    expect(providerCalls).toBe(0);
    const record = [...store.retrievals.values()][0];
    expect(record?.status).toBe("unknown_outcome");
    if (!record) throw new Error("Missing retrieval attempt");
    complete({
      id: record.id,
      queries: ["Question?"],
      sources: [],
      context: "late",
      raw_response: {},
      estimated_cost_usd: 0.02,
      reported_cost_usd: 0.015,
      created_at: new Date().toISOString(),
    });
    await until(() => store.retrievals.get(record.id)?.status === "succeeded");
    expect(store.retrievals.get(record.id)?.bundle?.reported_cost_usd).toBe(0.015);
    expect(providerCalls).toBe(0);
  });
  it("preserves billable failed HTTP200 vendor responses without marking success", async () => {
    const store = new Store();
    const partial = { ...result, finish_reason: "error", raw_response: { status: "failed" } };
    let settled: ProviderResult["usage"] | null = null;
    const r = runtime(store, {
      executeProvider: async () => {
        throw Object.assign(
          new ResearchError("provider_failed", "Provider returned a failed response"),
          { result: partial },
        );
      },
      hooks: {
        settled: async (_attempt, outcome, usage) => {
          expect(outcome).toBe("failed");
          settled = usage;
        },
      },
    });
    await r.executeObservation("observation");
    expect(store.observations.get("observation")?.status).toBe("failed");
    expect(store.observations.get("observation")?.result).toEqual(partial);
    expect(settled).toEqual(partial.usage);
  });
  it("classifies definite HTTP rejections as failed without paid retry", async () => {
    const store = new Store();
    let calls = 0;
    const r = runtime(store, {
      executeProvider: async () => {
        calls++;
        throw new ResearchError("provider_http_429", "Provider rejected the request");
      },
    });
    await r.executeObservation("observation");
    await r.executeObservation("observation");
    expect(store.observations.get("observation")?.status).toBe("failed");
    expect(calls).toBe(1);
  });
  it("persists real native execution and cost across application store reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runtime-integration-"));
    const url = `file:${join(directory, "research.db")}`;
    const store = new ResearchStore(createClient({ url }), "integration");
    await store.initialize();
    const target = targetSchema.parse({
      id: "mock",
      transport: "openai",
      model: "mock",
      search: { mode: "off" },
    });
    const input = runInputSchema.parse({
      prompts: [{ id: "p", text: "Question?" }],
      targets: [target.id],
      idempotency_key: "native-integration",
    });
    const estimate: RunEstimate = {
      total_observations: 1,
      estimated_cost_usd: 0.1,
      retrieval_estimated_cost_usd: 0,
      unpriced_targets: [],
      observations: [
        { prompt_id: "p", target_id: target.id, repetition: 0, estimated_cost_usd: 0.1 },
      ],
    };
    const { run } = await store.createRun(input, [target], estimate);
    const item = (await store.listPending())[0];
    if (!item) throw new Error("Missing observation");
    const r = createRuntime({
      store,
      storage: new LibSQLStore({ id: "integration-native", url }),
      env: {},
      role: "all",
      executeProvider: async () => result,
    });
    try {
      await r.executeObservation(item.id);
      await r.stop();
      await store.close();
      const reopened = new ResearchStore(createClient({ url }), "integration");
      try {
        expect((await reopened.getObservation(item.id))?.result).toEqual(result);
        expect((await reopened.getRun(run.id))?.reported_cost_usd).toBe(0.01);
        expect((await reopened.getRun(run.id))?.status).toBe("succeeded");
      } finally {
        await reopened.close();
      }
    } finally {
      await r.stop();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("retains late failed response usage after an ambiguous deadline", async () => {
    const store = new Store();
    let rejectCall!: (reason: unknown) => void;
    const r = runtime(store, {
      timeoutMs: 25,
      executeProvider: async () =>
        new Promise((_resolve, reject) => {
          rejectCall = reject;
        }),
    });
    await r.executeObservation("observation");
    expect(store.observations.get("observation")?.status).toBe("unknown_outcome");
    const partial = { ...result, finish_reason: "failed" };
    rejectCall(
      Object.assign(new ResearchError("provider_failed", "Provider returned a failed response"), {
        result: partial,
      }),
    );
    await until(() => store.observations.get("observation")?.status === "failed");
    expect(store.observations.get("observation")?.result).toEqual(partial);
  });
  it("allows direct queue execution in external API mode without native dispatch", async () => {
    const store = new Store();
    let calls = 0;
    const r = runtime(store, {
      role: "api",
      dispatchMode: "external",
      executeProvider: async () => {
        calls++;
        return result;
      },
    });
    await r.start();
    await r.dispatch(await store.listPending());
    expect(store.queued.size).toBe(0);
    expect(calls).toBe(0);
    await r.executeObservation("observation");
    expect(calls).toBe(1);
  });
});
