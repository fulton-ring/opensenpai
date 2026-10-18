import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ProviderResult,
  type RetrievalBundle,
  runInputSchema,
  type SpendAuthorization,
  targetSchema,
} from "../../src/contracts.js";
import { createRuntime } from "../../src/runtime/index.js";
import { drainSettlements } from "../../src/runtime/spend.js";
import { ResearchStore } from "../../src/storage/index.js";
import { RESEARCH_METHODS } from "../../src/storage/protocol.js";

const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

const result: ProviderResult = {
  answer: "answer",
  requested_model: "test",
  model: "test",
  serving_provider: null,
  response_id: null,
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
    reported_cost_usd: 0.02,
    estimated_cost_usd: 0.1,
    raw: {},
  },
  raw_response: {},
  warnings: [],
};

async function fixture(url = ":memory:") {
  let now = Date.now();
  const store = new ResearchStore(createClient({ url }), "test", {
    clock: () => new Date(now),
  });
  resources.push(() => store.close());
  await store.initialize();
  const target = targetSchema.parse({
    id: "t",
    transport: "openai",
    model: "test",
    search: { mode: "off" },
  });
  const { run } = await store.createRun(
    runInputSchema.parse({
      prompts: [{ id: "p", text: "hello" }],
      targets: ["t"],
      idempotency_key: "outbox",
    }),
    [target],
    {
      total_observations: 1,
      estimated_cost_usd: 0.1,
      retrieval_estimated_cost_usd: 0,
      unpriced_targets: [],
      observations: [{ prompt_id: "p", target_id: "t", repetition: 0, estimated_cost_usd: 0.1 }],
    },
  );
  const observation = (await store.listPending())[0];
  if (!observation) throw new Error("Expected observation");
  return {
    store,
    observation,
    run,
    expire: () => {
      now += 200_000;
    },
  };
}

it("atomically persists immutable usage and settlement, and ACKs only the requested event", async () => {
  const { store, observation } = await fixture();
  const claimed = await store.claim(observation.id, "owner");
  if (!claimed?.attempt_id) throw new Error("Expected claimed attempt");
  await store.markDispatched(observation.id, claimed.attempt_id);
  await store.fail(
    observation.id,
    claimed.attempt_id,
    { code: "timeout", message: "timeout", retryable: false },
    "unknown_outcome",
  );
  const [unknown] = await store.listPendingSettlements();
  expect(unknown).toMatchObject({
    attempt: { attempt_id: claimed.attempt_id, operation: "model", observation_id: observation.id },
    outcome: "unknown_outcome",
    usage: null,
  });
  await store.succeed(observation.id, claimed.attempt_id, result);
  await store.succeed(observation.id, claimed.attempt_id, result);
  const pending = await store.listPendingSettlements();
  expect(pending).toHaveLength(2);
  expect(pending[1]).toMatchObject({ outcome: "succeeded", usage: result.usage });
  if (!unknown) throw new Error("Expected unknown event");
  expect(pending[1]?.id).not.toBe(unknown.id);
  await store.ackSettlement(unknown.id);
  expect(await store.listPendingSettlements()).toEqual([pending[1]]);
  expect((await store.getRun(observation.run_id))?.reported_cost_usd).toBe(0.02);
  expect(RESEARCH_METHODS).toContain("listPendingSettlements");
  expect(RESEARCH_METHODS).toContain("ackSettlement");
});

it("recovers authorization holds with known zero before dispatch and preserves unknown dispatched holds", async () => {
  const { store, observation, expire } = await fixture();
  const claimed = await store.claim(observation.id, "owner");
  if (!claimed?.attempt_id) throw new Error("Expected claimed attempt");
  expire();
  await store.recoverExpired();
  const [event] = await store.listPendingSettlements();
  expect(event).toMatchObject({
    attempt: { attempt_id: claimed.attempt_id },
    usage: { reported_cost_usd: 0 },
  });
  expect((await store.getRun(observation.run_id))?.reserved_cost_usd).toBe(0);
  const next = await store.claim(observation.id, "next");
  if (!next?.attempt_id) throw new Error("Expected next attempt");
  await store.markDispatched(observation.id, next.attempt_id);
  expire();
  await store.recoverExpired();
  expect((await store.listPendingSettlements())[1]).toMatchObject({
    outcome: "unknown_outcome",
    usage: null,
  });
  expect((await store.getRun(observation.run_id))?.reserved_cost_usd).toBe(0.1);
});

it("retries failed callbacks on restart without replaying paid work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settlement-restart-"));
  resources.push(() => rm(directory, { recursive: true, force: true }));
  const url = `file:${join(directory, "research.db")}`;
  const { store, observation } = await fixture(url);
  const paid = vi.fn(async () => result);
  const settled = vi.fn(async () => {
    throw new Error("wallet unavailable");
  });
  const runtime = createRuntime({
    store,
    role: "all",
    directOnly: true,
    env: {},
    storage: new LibSQLStore({ id: "first", url: ":memory:" }),
    executeProvider: paid,
    hooks: { settled },
    onError: () => undefined,
  });
  resources.push(() => runtime.stop());
  await runtime.executeObservation(observation.id);
  expect((await store.getObservation(observation.id))?.status).toBe("succeeded");
  expect(await store.listPendingSettlements()).toHaveLength(1);
  await runtime.stop();
  await store.close();
  const reopened = new ResearchStore(createClient({ url }), "test");
  resources.push(() => reopened.close());
  await reopened.initialize();
  const delivered = vi.fn(async () => undefined);
  const restarted = createRuntime({
    store: reopened,
    role: "all",
    directOnly: true,
    env: {},
    storage: new LibSQLStore({ id: "second", url: ":memory:" }),
    executeProvider: paid,
    hooks: { settled: delivered },
  });
  resources.push(() => restarted.stop());
  await restarted.start();
  await restarted.executeObservation(observation.id);
  expect(delivered).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ attempt_id: expect.any(String) }),
    "succeeded",
    result.usage,
  );
  expect(await reopened.listPendingSettlements()).toEqual([]);
  expect(paid).toHaveBeenCalledTimes(1);
});

it("rolls back terminal evidence when inserting its outbox event fails", async () => {
  const { store, observation } = await fixture();
  const claimed = await store.claim(observation.id, "owner");
  if (!claimed?.attempt_id) throw new Error("Expected claim");
  await store.markDispatched(observation.id, claimed.attempt_id);
  await store.client.execute(
    "CREATE TRIGGER reject_outbox BEFORE INSERT ON app_settlements BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END",
  );
  await expect(store.succeed(observation.id, claimed.attempt_id, result)).rejects.toThrow(
    "outbox unavailable",
  );
  expect((await store.getObservation(observation.id))?.status).toBe("running");
  expect((await store.client.execute("SELECT * FROM app_usage")).rows).toHaveLength(0);
  await store.client.execute("DROP TRIGGER reject_outbox");
  await store.succeed(observation.id, claimed.attempt_id, result);
  expect(await store.listPendingSettlements()).toHaveLength(1);
});

it("repeats the same immutable event after ACK loss and keeps host charging idempotent", async () => {
  const { store, observation } = await fixture();
  const claimed = await store.claim(observation.id, "owner");
  if (!claimed?.attempt_id) throw new Error("Expected claim");
  await store.succeed(observation.id, claimed.attempt_id, result);
  const events = await store.listPendingSettlements();
  const charged = new Map<string, number>();
  const settled = vi.fn(
    async (attempt: SpendAuthorization, _outcome: string, usage: typeof result.usage | null) => {
      charged.set(attempt.attempt_id, usage?.reported_cost_usd ?? 0);
    },
  );
  vi.spyOn(store, "ackSettlement").mockRejectedValueOnce(new Error("ACK lost"));
  const options = { store, env: {}, role: "all" as const, hooks: { settled } };
  await drainSettlements(options);
  expect(await store.listPendingSettlements()).toEqual(events);
  await drainSettlements(options);
  expect(settled).toHaveBeenCalledTimes(2);
  expect([...charged.values()]).toEqual([0.02]);
  expect(await store.listPendingSettlements()).toEqual([]);
});

it("delivers unknown and later known evidence independently, using stored usage", async () => {
  const { store, observation } = await fixture();
  const claimed = await store.claim(observation.id, "owner");
  if (!claimed?.attempt_id) throw new Error("Expected claim");
  await store.markDispatched(observation.id, claimed.attempt_id);
  await store.fail(
    observation.id,
    claimed.attempt_id,
    { code: "timeout", message: "timeout", retryable: false },
    "unknown_outcome",
  );
  const delivered: (number | null)[] = [];
  const options = {
    store,
    env: {},
    role: "all" as const,
    hooks: {
      settled: async (
        _attempt: SpendAuthorization,
        _outcome: string,
        usage: typeof result.usage | null,
      ) => {
        delivered.push(usage?.reported_cost_usd ?? null);
      },
    },
  };
  await drainSettlements(options);
  await store.succeed(observation.id, claimed.attempt_id, result);
  await drainSettlements(options);
  expect(delivered).toEqual([null, 0.02]);
  expect(await store.listPendingSettlements()).toEqual([]);
});

it("persists the exact shared retrieval authorization and emits one settlement", async () => {
  const { store, observation, run } = await fixture();
  const authorization: SpendAuthorization = {
    workspace_id: "test",
    run_id: run.id,
    observation_id: observation.id,
    attempt_id: "bundle",
    operation: "retrieval",
    estimated_cost_usd: 0.04,
  };
  await store.setRetrieval(observation.id, "bundle");
  expect(await store.claimRetrieval("bundle", run.id, "owner", 150_000, 0.04, authorization)).toBe(
    true,
  );
  expect(
    await store.claimRetrieval("bundle", run.id, "other", 150_000, 0.04, {
      ...authorization,
      observation_id: "loser",
    }),
  ).toBe(false);
  const bundle: RetrievalBundle = {
    id: "bundle",
    queries: ["hello"],
    context: "context",
    sources: [],
    raw_response: {},
    reported_cost_usd: 0.03,
    estimated_cost_usd: 0.04,
    created_at: new Date().toISOString(),
  };
  await store.finishRetrieval(bundle, "owner", run.id);
  await store.finishRetrieval(bundle, "owner", run.id);
  expect(await store.listPendingSettlements()).toEqual([
    expect.objectContaining({
      attempt: authorization,
      outcome: "succeeded",
      usage: expect.objectContaining({ reported_cost_usd: 0.03, search_requests: 1 }),
    }),
  ]);
  const pending = await store.listPendingSettlements();
  const other = new ResearchStore(store.client, "other");
  await other.ackSettlement(pending[0]?.id ?? "");
  expect(await store.listPendingSettlements()).toEqual(pending);
  await drainSettlements({ store, env: {}, role: "all" });
  expect(await store.listPendingSettlements()).toEqual([]);
});
