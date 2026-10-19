import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ProviderResult,
  runInputSchema,
  type SpendAuthorization,
  targetSchema,
} from "../../src/contracts.js";
import { createRuntime } from "../../src/runtime/index.js";
import { drainSettlements } from "../../src/runtime/spend.js";
import { reconcilePendingUsage } from "../../src/runtime/usage.js";
import { ResearchStore } from "../../src/storage/index.js";

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

it("keeps missing costs after ACK and restart, claims once, and preserves three immutable revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "accounting-restart-"));
  resources.push(() => rm(directory, { recursive: true, force: true }));
  const url = `file:${join(directory, "research.db")}`;
  const { store, observation } = await fixture(url);
  const claim = await store.claim(observation.id, "executor");
  const attempt = claim?.attempt_id;
  if (!attempt) throw new Error("Missing attempt");
  await store.succeed(observation.id, attempt, {
    ...result,
    response_id: "gen-1",
    usage: { ...result.usage, reported_cost_usd: null },
  });
  const initial = (await store.listPendingSettlements())[0];
  if (!initial) throw new Error("Missing event");
  await store.ackSettlement(initial.id);
  await store.close();
  const reopened = new ResearchStore(createClient({ url }), "test");
  resources.push(() => reopened.close());
  await reopened.initialize();
  expect(await reopened.listPendingUsageReconciliations()).toHaveLength(1);
  const claims = await Promise.all([
    reopened.claimUsageReconciliation(attempt, "a"),
    reopened.claimUsageReconciliation(attempt, "b"),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  await reopened.finishUsageReconciliation(observation.id, claims[0] ? "a" : "b", result.usage);
  await reopened.correctUsage(observation.id, attempt, {
    ...result.usage,
    reported_cost_usd: 0.04,
  });
  await reopened.correctUsage(observation.id, attempt, {
    ...result.usage,
    reported_cost_usd: 0.04,
  });
  expect(
    (
      await reopened.client.execute("SELECT revision FROM app_usage_revisions ORDER BY revision")
    ).rows.map((r) => r.revision),
  ).toEqual([1, 2, 3]);
  expect(await reopened.getObservation(observation.id)).toMatchObject({
    status: "succeeded",
    result: { response_id: "gen-1", usage: { reported_cost_usd: 0.04 } },
  });
  expect(await reopened.getRun(observation.run_id)).toMatchObject({
    reported_cost_usd: 0.04,
    reserved_cost_usd: 0,
  });
  expect(await reopened.listPendingUsageReconciliations()).toEqual([]);
  const delivered: number[] = [];
  const options = {
    store: reopened,
    env: {},
    role: "all" as const,
    hooks: {
      settled: async (_a: SpendAuthorization, _o: unknown, _u: unknown, revision?: number) => {
        delivered.push(revision ?? 0);
      },
    },
  };
  await drainSettlements(options);
  await drainSettlements(options);
  expect(delivered).toEqual([2, 3]);
});

it("reconciles failed partial responses without generating and backs off missing identifiers", async () => {
  const { store, observation, expire } = await fixture();
  const claim = await store.claim(observation.id, "executor");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await store.markDispatched(observation.id, claim.attempt_id);
  await store.fail(
    observation.id,
    claim.attempt_id,
    { code: "provider_failed", message: "failed", retryable: false },
    "failed",
    { ...result, usage: { ...result.usage, reported_cost_usd: null } },
  );
  const execute = vi.fn();
  const reconcileUsage = vi.fn(async () => null as typeof result.usage | null);
  const options = {
    store,
    env: {},
    role: "all" as const,
    providers: {
      models: { openai: { availability: () => ({ available: true }), execute, reconcileUsage } },
      retrievals: {},
    },
  };
  await reconcilePendingUsage(options);
  expect(await store.listPendingUsageReconciliations()).toEqual([]);
  expect(await store.listPendingUsageReconciliations(1, true)).toHaveLength(1);
  await reconcilePendingUsage(options);
  expect(reconcileUsage).toHaveBeenCalledTimes(1);
  expire();
  reconcileUsage.mockResolvedValue(result.usage);
  await reconcilePendingUsage(options);
  expect(execute).not.toHaveBeenCalled();
  expect((await store.getObservation(observation.id))?.status).toBe("failed");
  expect((await store.getRun(observation.run_id))?.reported_cost_usd).toBe(0.02);
});

it("defers poison attempts, filters before limiting, and keeps newer revisions behind failed ones", async () => {
  const { store, observation, expire } = await fixture();
  const claim = await store.claim(observation.id, "executor");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await store.succeed(observation.id, claim.attempt_id, result);
  const initial = (await store.listPendingSettlements())[0];
  if (!initial) throw new Error("Missing event");
  await store.correctUsage(observation.id, claim.attempt_id, {
    ...result.usage,
    reported_cost_usd: 0.03,
  });
  const other = {
    ...initial,
    id: "other:initial",
    attempt: { ...initial.attempt, attempt_id: "other" },
  };
  await store.client.execute({
    sql: "INSERT INTO app_settlements(workspace_id,id,data) VALUES(?,?,?)",
    args: ["test", other.id, JSON.stringify(other)],
  });
  expect(await store.listPendingSettlements(1, other.attempt)).toEqual([other]);
  const revisions: number[] = [];
  const settled = vi.fn(
    async (attempt: SpendAuthorization, _o: unknown, _u: unknown, revision?: number) => {
      if (attempt.attempt_id === claim.attempt_id) {
        revisions.push(revision ?? 0);
        throw new Error("poison");
      }
    },
  );
  await drainSettlements({ store, env: {}, role: "all", hooks: { settled } });
  expect(settled).toHaveBeenCalledTimes(2);
  expect(revisions).toEqual([1]);
  expect(await store.listPendingSettlements()).toEqual([]);
  expire();
  expect((await store.listPendingSettlements())[0]?.revision).toBe(1);
});

it("executes new work while an unrelated settlement callback remains blocked", async () => {
  const { store, observation } = await fixture();
  const blocked = {
    id: "unrelated:initial",
    revision: 1,
    outcome: "succeeded",
    attempt: {
      workspace_id: "test",
      attempt_id: "unrelated",
      operation: "model",
      run_id: observation.run_id,
      observation_id: "other",
      estimated_cost_usd: 0.1,
    },
    usage: result.usage,
  };
  await store.client.execute({
    sql: "INSERT INTO app_settlements(workspace_id,id,data) VALUES(?,?,?)",
    args: ["test", blocked.id, JSON.stringify(blocked)],
  });
  let release!: () => void;
  let entered!: () => void;
  const blockedCall = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredCall = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paid = vi.fn(async () => result);
  const options = {
    store,
    env: {},
    role: "all" as const,
    directOnly: true,
    storage: new LibSQLStore({ id: "independent", url: ":memory:" }),
    executeProvider: paid,
    hooks: {
      settled: async (attempt: SpendAuthorization) => {
        if (attempt.attempt_id === "unrelated") {
          entered();
          await blockedCall;
        }
      },
    },
  };
  const delivery = drainSettlements(options);
  await enteredCall;
  const runtime = createRuntime(options);
  resources.push(() => runtime.stop());
  try {
    await runtime.start();
    await runtime.executeObservation(observation.id);
    expect(paid).toHaveBeenCalledTimes(1);
    expect((await store.getObservation(observation.id))?.status).toBe("succeeded");
  } finally {
    release();
    await delivery;
  }
});

it("imports legacy initial and reconciliation records before assigning revision three", async () => {
  const { store, observation } = await fixture();
  const claimed = await store.claim(observation.id, "worker");
  if (!claimed?.attempt_id) throw new Error("Missing attempt");
  await store.markDispatched(observation.id, claimed.attempt_id);
  await store.fail(
    observation.id,
    claimed.attempt_id,
    { code: "timeout", message: "timeout", retryable: false },
    "unknown_outcome",
  );
  await store.succeed(observation.id, claimed.attempt_id, result);
  await store.client.execute("DELETE FROM app_usage_revisions");
  await store.client.execute("UPDATE app_settlements SET data=json_remove(data,'$.revision')");
  await store.correctUsage(observation.id, claimed.attempt_id, {
    ...result.usage,
    reported_cost_usd: 0.05,
  });
  const revisions = [];
  for (let i = 0; i < 3; i++) {
    const event = (await store.listPendingSettlements())[0];
    if (!event) throw new Error("Missing revision");
    revisions.push(event.revision);
    await store.ackSettlement(event.id);
  }
  expect(revisions).toEqual([1, 2, 3]);
});

it("bounds a hung settlement batch, delivers healthy attempts, and never ACKs late completion", async () => {
  const { store, observation, expire } = await fixture();
  const claim = await store.claim(observation.id, "worker");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await store.succeed(observation.id, claim.attempt_id, result);
  const first = (await store.listPendingSettlements())[0];
  if (!first) throw new Error("Missing event");
  const other = {
    ...first,
    id: "healthy:initial",
    attempt: { ...first.attempt, attempt_id: "healthy" },
  };
  await store.client.execute({
    sql: "INSERT INTO app_settlements(workspace_id,id,data) VALUES(?,?,?)",
    args: ["test", other.id, JSON.stringify(other)],
  });
  let finish!: () => void;
  const hung = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const settled = vi.fn(async (attempt: SpendAuthorization) => {
    if (attempt.attempt_id === claim.attempt_id) await hung;
  });
  const options = {
    store,
    env: {},
    role: "all" as const,
    settlementTimeoutMs: 5,
    hooks: { settled },
  };
  await drainSettlements(options);
  expect(settled).toHaveBeenCalledTimes(2);
  expect(await store.listPendingSettlements(10, undefined, true)).toEqual([first]);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await store.listPendingSettlements(10, undefined, true)).toEqual([first]);
  expire();
  await drainSettlements(options);
  expect(settled).toHaveBeenCalledTimes(3);
  expect(await store.listPendingSettlements(10, undefined, true)).toEqual([]);
});
