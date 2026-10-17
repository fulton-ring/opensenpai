import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProviderResult,
  type RunEstimate,
  runInputSchema,
  targetSchema,
} from "../src/contracts.js";
import { ResearchStore } from "../src/storage/index.js";

const target = targetSchema.parse({
  id: "t",
  transport: "openai",
  model: "test",
  search: { mode: "off" },
});
const input = runInputSchema.parse({
  prompts: [{ id: "p", text: "hello" }],
  targets: ["t"],
  idempotency_key: "key",
  max_estimated_cost_usd: 1,
});
const estimate: RunEstimate = {
  total_observations: 1,
  estimated_cost_usd: 0.1,
  retrieval_estimated_cost_usd: 0,
  unpriced_targets: [],
  observations: [{ prompt_id: "p", target_id: "t", repetition: 0, estimated_cost_usd: 0.1 }],
};
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
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_tokens: null,
    search_requests: null,
    reported_cost_usd: 0.02,
    estimated_cost_usd: 0.1,
    raw: { tokens: 1 },
  },
  raw_response: { secret: "raw" },
  warnings: [],
};
let directory: string;
let stores: ResearchStore[];
let now: number;
async function store(workspace = "local") {
  const client = createClient({ url: `file:${join(directory, "test.db")}` });
  const value = new ResearchStore(client, workspace, { clock: () => new Date(now) });
  await value.initialize();
  stores.push(value);
  return value;
}
async function observation(value: ResearchStore) {
  const { run } = await value.createRun(input, [target], estimate);
  const rows = await value.getResults({ run_id: run.id });
  const item = rows.observations[0];
  if (!item) throw new Error("Missing observation");
  return item;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "research-storage-"));
  stores = [];
  now = Date.now();
});
afterEach(async () => {
  await Promise.all(stores.map((value) => value.close()));
  await rm(directory, { recursive: true, force: true });
});

describe("ResearchStore", () => {
  it("isolates workspaces and conflicting canonical idempotency snapshots", async () => {
    const a = await store();
    const b = await store("other");
    const first = await a.createRun(input, [target], estimate);
    expect((await a.createRun(input, [target], estimate)).created).toBe(false);
    expect((await b.createRun(input, [target], estimate)).created).toBe(true);
    expect(await b.getRun(first.run.id)).toBeNull();
    await expect(a.createRun({ ...input, locale: "fr" }, [target], estimate)).rejects.toMatchObject(
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    await expect(
      a.createRun(input, [{ ...target, model: "changed" }], estimate),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("serializes create and claims across separate database clients", async () => {
    const a = await store();
    const b = await store();
    const runs = await Promise.all([
      a.createRun(input, [target], estimate),
      b.createRun(input, [target], estimate),
    ]);
    expect(runs.map((row) => row.created).filter(Boolean)).toHaveLength(1);
    const item = await observation(a);
    const claims = await Promise.all([a.claim(item.id, "a"), b.claim(item.id, "b")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await a.getRun(item.run_id))?.reserved_cost_usd).toBe(0.1);
  });
  it("preserves in-flight results and actual costs after cancellation, deduplicates settlement", async () => {
    const a = await store();
    const item = await observation(a);
    const claimed = await a.claim(item.id, "a");
    if (!claimed?.attempt_id) throw new Error("Missing attempt");
    await a.markDispatched(item.id, claimed.attempt_id);
    await a.cancelRun(item.run_id);
    await a.succeed(item.id, claimed.attempt_id, result);
    await a.succeed(item.id, claimed.attempt_id, result);
    expect(await a.getRun(item.run_id)).toMatchObject({
      cancel_requested: true,
      reported_cost_usd: 0.02,
      reserved_cost_usd: 0,
    });
    expect((await a.getObservation(item.id))?.status).toBe("succeeded");
    const page = await a.getResults({ run_id: item.run_id });
    expect(page.observations[0]?.result).not.toHaveProperty("raw_response");
    expect(
      (await a.getResults({ run_id: item.run_id, include_raw: true })).observations[0]?.result
        ?.raw_response,
    ).toEqual(result.raw_response);
  });
  it("recovers only pre-dispatch leases; ambiguous paid attempts remain reserved", async () => {
    const a = await store();
    const item = await observation(a);
    await a.claim(item.id, "a", 10);
    now += 11;
    expect(await a.recoverExpired()).toBe(1);
    expect((await a.getObservation(item.id))?.status).toBe("pending");
    const second = await a.claim(item.id, "b", 10);
    if (!second?.attempt_id) throw new Error("Missing attempt");
    await a.markDispatched(item.id, second.attempt_id);
    now += 11;
    await a.recoverExpired();
    expect((await a.getObservation(item.id))?.status).toBe("unknown_outcome");
    expect(await a.claim(item.id, "c")).toBeNull();
    expect((await a.getRun(item.run_id))?.reserved_cost_usd).toBe(0.1);
  });
  it("keeps missing actual usage unknown and ignores stale attempts", async () => {
    const a = await store();
    const item = await observation(a);
    const claim = await a.claim(item.id, "a");
    if (!claim?.attempt_id) throw new Error("Missing attempt");
    await a.succeed(item.id, "stale", result);
    expect((await a.getObservation(item.id))?.status).toBe("running");
    await a.succeed(item.id, claim.attempt_id, {
      ...result,
      usage: { ...result.usage, reported_cost_usd: null },
    });
    expect((await a.getObservation(item.id))?.result?.usage.reported_cost_usd).toBeNull();
    expect((await a.getRun(item.run_id))?.reserved_cost_usd).toBe(0.1);
  });
});

it("paginates stable ordinals, marks outbox rows, and blocks cancelled pending work", async () => {
  const a = await store();
  const { run } = await a.createRun({ ...input, repetitions: 2 }, [target], {
    ...estimate,
    total_observations: 2,
  });
  const first = await a.getResults({ run_id: run.id, limit: 1 });
  expect(first.observations).toHaveLength(1);
  expect(first.next_cursor).toBe(0);
  const second = await a.getResults({
    run_id: run.id,
    cursor: first.next_cursor ?? undefined,
    limit: 1,
  });
  expect(second.observations[0]?.ordinal).toBe(1);
  expect(second.next_cursor).toBeNull();
  const item = first.observations[0];
  if (!item) throw new Error("Missing item");
  await a.markQueued(item.id);
  expect(await a.listUnqueued()).toHaveLength(1);
  await a.cancelRun(run.id);
  expect(await a.claim(item.id, "a")).toBeNull();
  expect(await a.listPending()).toHaveLength(0);
  await a.recordToolCall("get_research", run.id);
  expect(await a.listToolCalls(run.id)).toMatchObject([{ tool: "get_research", run_id: run.id }]);
});

it("uses immutable retrieval ownership and accounts a bundle exactly once", async () => {
  const a = await store();
  const b = await store();
  const item = await observation(a);
  expect(await a.claimRetrieval("bundle", item.run_id, "a", 100, 0.2)).toBe(true);
  expect(await b.claimRetrieval("bundle", item.run_id, "b", 100, 0.2)).toBe(false);
  const bundle = {
    id: "bundle",
    queries: ["hello"],
    sources: [],
    context: "context",
    raw_response: {},
    estimated_cost_usd: 0.2,
    reported_cost_usd: 0.03,
    created_at: new Date(now).toISOString(),
  };
  await a.finishRetrieval(bundle, "wrong", item.run_id);
  expect((await a.getRetrieval("bundle"))?.status).toBe("running");
  await a.finishRetrieval(bundle, "a", item.run_id);
  await a.finishRetrieval(bundle, "a", item.run_id);
  expect((await a.getRun(item.run_id))?.reported_cost_usd).toBe(0.03);
  expect((await a.getRetrieval("bundle"))?.bundle).toEqual(bundle);
});

it("never repeats failed or ambiguous retrieval, and enforces reserved budgets", async () => {
  const a = await store();
  const item = await observation(a);
  expect(await a.claimRetrieval("large", item.run_id, "a", 100, 2)).toBe(false);
  expect(await a.claimRetrieval("failed", item.run_id, "a", 100, 0.2)).toBe(true);
  await a.failRetrieval("failed", "a", { code: "FAIL", message: "failed", retryable: true }, false);
  expect(await a.claimRetrieval("failed", item.run_id, "a", 100, 0.2)).toBe(false);
  expect(await a.claimRetrieval("unknown", item.run_id, "a", 10, 0.2)).toBe(true);
  now += 11;
  await a.recoverExpired();
  expect((await a.getRetrieval("unknown"))?.status).toBe("unknown_outcome");
  expect((await a.getRun(item.run_id))?.reserved_cost_usd).toBe(0.4);
});

it("accepts late paid results for the same uncertain attempt once", async () => {
  const a = await store();
  const item = await observation(a);
  const claim = await a.claim(item.id, "a", 10);
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await a.markDispatched(item.id, claim.attempt_id);
  now += 11;
  await a.recoverExpired();
  await a.succeed(item.id, claim.attempt_id, result);
  await a.succeed(item.id, claim.attempt_id, result);
  expect((await a.getObservation(item.id))?.status).toBe("succeeded");
  expect(await a.getRun(item.run_id)).toMatchObject({
    reported_cost_usd: 0.02,
    reserved_cost_usd: 0,
  });
});

it("refuses dispatch if cancellation won after the observation claim", async () => {
  const a = await store();
  const item = await observation(a);
  const claim = await a.claim(item.id, "a");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await a.cancelRun(item.run_id);
  expect(await a.markDispatched(item.id, claim.attempt_id)).toBe(false);
  expect((await a.getObservation(item.id))?.dispatched_at).toBeNull();
});

it("leaves completed runs untouched when cancellation arrives after completion", async () => {
  const a = await store();
  const item = await observation(a);
  const claim = await a.claim(item.id, "a");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await a.succeed(item.id, claim.attempt_id, result);
  const before = await a.getRun(item.run_id);
  now += 100;
  expect(await a.cancelRun(item.run_id)).toEqual(before);
  expect((await a.getRun(item.run_id))?.cancel_requested).toBe(false);
});

it("retains immutable usage history while reconciling late actual charges", async () => {
  const a = await store();
  const item = await observation(a);
  const claim = await a.claim(item.id, "a", 1);
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await a.markDispatched(item.id, claim.attempt_id);
  now += 2;
  await a.recoverExpired();
  const before = await a.client.execute({
    sql: "SELECT data FROM app_usage WHERE workspace_id=? AND attempt_id=?",
    args: ["local", claim.attempt_id],
  });
  await a.succeed(item.id, claim.attempt_id, result);
  await a.succeed(item.id, claim.attempt_id, result);
  const after = await a.client.execute({
    sql: "SELECT data FROM app_usage WHERE workspace_id=? AND attempt_id=?",
    args: ["local", claim.attempt_id],
  });
  expect(after.rows).toEqual(before.rows);
  const reconciliations = await a.client.execute("SELECT data FROM app_usage_reconciliations");
  expect(reconciliations.rows).toHaveLength(1);
  expect(JSON.parse(String(reconciliations.rows[0]?.data))).toMatchObject({
    reported_cost_usd: 0.02,
    estimated_cost_usd: 0.1,
  });
});

it("reserves concurrent observations against the same run budget atomically", async () => {
  const a = await store();
  const b = await store();
  const { run } = await a.createRun(
    { ...input, repetitions: 2, max_estimated_cost_usd: 0.15 },
    [target],
    {
      ...estimate,
      total_observations: 2,
      observations: [
        { prompt_id: "p", target_id: "t", repetition: 0, estimated_cost_usd: 0.1 },
        { prompt_id: "p", target_id: "t", repetition: 1, estimated_cost_usd: 0.1 },
      ],
    },
  );
  const rows = (await a.getResults({ run_id: run.id })).observations;
  const claims = await Promise.all(
    rows.map((item, index) => (index ? b : a).claim(item.id, "worker")),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect((await a.getRun(run.id))?.reserved_cost_usd).toBe(0.1);
});

it("records failed attempts once and releases only a known non-dispatched reservation", async () => {
  const a = await store();
  const item = await observation(a);
  const claim = await a.claim(item.id, "a");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  const failure = { code: "NOT_SENT", message: "Authorization denied", retryable: false };
  await a.fail(item.id, "stale", failure, "failed");
  expect((await a.getObservation(item.id))?.status).toBe("running");
  await a.fail(item.id, claim.attempt_id, failure, "failed");
  await a.fail(item.id, claim.attempt_id, failure, "failed");
  expect((await a.getRun(item.run_id))?.reserved_cost_usd).toBe(0);
  expect((await a.getObservation(item.id))?.error).toEqual(failure);
  const usage = await a.client.execute("SELECT data FROM app_usage");
  expect(usage.rows).toHaveLength(1);
  expect(JSON.parse(String(usage.rows[0]?.data))).toMatchObject({
    reported_cost_usd: null,
    estimated_cost_usd: 0.1,
  });
  expect(await a.claim(item.id, "retry")).toBeNull();
});

it("isolates observations, claims, retrievals, lists and audit rows across workspaces", async () => {
  const a = await store();
  const b = await store("other");
  const item = await observation(a);
  await a.claimRetrieval("bundle", item.run_id, "a", 100, 0.01);
  await a.setRetrieval(item.id, "bundle");
  await a.recordToolCall("start_run", item.run_id);
  expect(await b.getObservation(item.id)).toBeNull();
  expect(await b.claim(item.id, "b")).toBeNull();
  expect(await b.getRetrieval("bundle")).toBeNull();
  expect(await b.cancelRun(item.run_id)).toBeNull();
  expect((await b.getResults({ run_id: item.run_id })).observations).toEqual([]);
  expect(await b.listRuns()).toEqual([]);
  expect(await b.listPending()).toEqual([]);
  expect(await b.listToolCalls()).toEqual([]);
  await b.setRetrieval(item.id, "bad");
  await b.markQueued(item.id);
  expect((await a.getObservation(item.id))?.retrieval_id).toBe("bundle");
  expect(await a.listUnqueued()).toHaveLength(1);
});

it("reopens durable results and keeps initialization idempotent without touching other tables", async () => {
  const a = await store();
  await a.client.execute("CREATE TABLE mastra_sentinel (value TEXT)");
  await a.client.execute("INSERT INTO mastra_sentinel VALUES ('retained')");
  const item = await observation(a);
  const claim = await a.claim(item.id, "a");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await a.succeed(item.id, claim.attempt_id, result);
  await a.close();
  const b = await store();
  await b.initialize();
  expect((await b.getObservation(item.id))?.result).toEqual(result);
  expect((await b.getRun(item.run_id))?.reported_cost_usd).toBe(0.02);
  expect((await b.client.execute("SELECT value FROM mastra_sentinel")).rows[0]?.value).toBe(
    "retained",
  );
});

it("reconciles one late retrieval result without repeating or mutating original usage", async () => {
  const a = await store();
  const item = await observation(a);
  await a.claimRetrieval("late-bundle", item.run_id, "a", 1, 0.02);
  now += 2;
  await a.recoverExpired();
  const bundle = {
    id: "late-bundle",
    queries: ["q"],
    sources: [],
    context: "late",
    raw_response: {},
    estimated_cost_usd: 0.02,
    reported_cost_usd: 0.01,
    created_at: new Date(now).toISOString(),
  };
  await a.finishRetrieval(bundle, "a", item.run_id);
  await a.finishRetrieval(bundle, "a", item.run_id);
  expect((await a.getRetrieval(bundle.id))?.bundle).toEqual(bundle);
  expect(await a.getRun(item.run_id)).toMatchObject({
    reported_cost_usd: 0.01,
    reserved_cost_usd: 0,
  });
  expect((await a.client.execute("SELECT data FROM app_usage")).rows).toHaveLength(1);
  expect((await a.client.execute("SELECT data FROM app_usage_reconciliations")).rows).toHaveLength(
    1,
  );
});

it("persists partial failed response evidence and actual charges without changing failure status", async () => {
  const a = await store();
  const item = await observation(a);
  const claim = await a.claim(item.id, "a");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await a.markDispatched(item.id, claim.attempt_id);
  const failure = {
    code: "PROVIDER_RESPONSE_FAILED",
    message: "Provider returned a failed response",
    retryable: false,
  };
  await a.fail(item.id, claim.attempt_id, failure, "failed", result);
  await a.fail(item.id, claim.attempt_id, failure, "failed", {
    ...result,
    usage: { ...result.usage, reported_cost_usd: 99 },
  });
  expect(await a.getObservation(item.id)).toMatchObject({
    status: "failed",
    result,
    error: failure,
  });
  expect(await a.getRun(item.run_id)).toMatchObject({
    status: "failed",
    reported_cost_usd: 0.02,
    reserved_cost_usd: 0,
  });
  expect((await a.getResults({ run_id: item.run_id })).observations[0]?.result).not.toHaveProperty(
    "raw_response",
  );
  expect(
    (await a.getResults({ run_id: item.run_id, include_raw: true })).observations[0]?.result
      ?.raw_response,
  ).toEqual(result.raw_response);
  expect((await a.client.execute("SELECT data FROM app_usage")).rows).toHaveLength(1);
});

it("retains an unknown charge reservation on a partial failed response without actual cost", async () => {
  const a = await store();
  const item = await observation(a);
  const claim = await a.claim(item.id, "a");
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await a.markDispatched(item.id, claim.attempt_id);
  const partial = { ...result, usage: { ...result.usage, reported_cost_usd: null } };
  await a.fail(
    item.id,
    claim.attempt_id,
    { code: "FAILED", message: "failed", retryable: false },
    "failed",
    partial,
  );
  expect((await a.getObservation(item.id))?.result?.usage.reported_cost_usd).toBeNull();
  expect((await a.getRun(item.run_id))?.reserved_cost_usd).toBe(0.1);
});

it("retains failed retrieval estimates when actual charges remain unknown", async () => {
  const a = await store();
  const item = await observation(a);
  expect(await a.claimRetrieval("first-retrieval", item.run_id, "a", 100, 0.7)).toBe(true);
  await a.failRetrieval(
    "first-retrieval",
    "a",
    { code: "HTTP_FAILURE", message: "Retrieval failed", retryable: false },
    false,
  );
  expect((await a.getRun(item.run_id))?.reserved_cost_usd).toBe(0.7);
  expect(await a.claimRetrieval("next-retrieval", item.run_id, "a", 100, 0.6)).toBe(false);
});

it("reconciles a late failed response for its uncertain attempt once", async () => {
  const a = await store();
  const item = await observation(a);
  const claim = await a.claim(item.id, "a", 1);
  if (!claim?.attempt_id) throw new Error("Missing attempt");
  await a.markDispatched(item.id, claim.attempt_id);
  now += 2;
  await a.recoverExpired();
  await a.fail(
    item.id,
    claim.attempt_id,
    { code: "FAILED", message: "Provider failed", retryable: false },
    "failed",
    result,
  );
  expect((await a.getObservation(item.id))?.status).toBe("failed");
  expect(await a.getRun(item.run_id)).toMatchObject({
    reported_cost_usd: 0.02,
    reserved_cost_usd: 0,
  });
  expect((await a.client.execute("SELECT data FROM app_usage_reconciliations")).rows).toHaveLength(
    1,
  );
});

it("filters unpublished outbox rows by run before applying the page limit", async () => {
  const a = await store();
  await observation(a);
  const { run } = await a.createRun(
    { ...input, idempotency_key: "another-run" },
    [target],
    estimate,
  );
  const rows = await a.listUnqueued(1, run.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.run_id).toBe(run.id);
  const row = rows[0];
  if (!row) throw new Error("Missing observation");
  await a.markQueued(row.id);
  expect(await a.listUnqueued(1, run.id)).toEqual([]);
  expect(await a.listUnqueued(1)).toHaveLength(1);
});

it("republishes safely recovered pre-dispatch claims through the outbox", async () => {
  const a = await store();
  const item = await observation(a);
  await a.markQueued(item.id);
  await a.claim(item.id, "a", 1);
  now += 2;
  await a.recoverExpired();
  expect((await a.listUnqueued()).map((row) => row.id)).toContain(item.id);
});

it("resets only pending workspace queue flags for combined-process startup repair", async () => {
  const a = await store();
  const b = await store("other");
  const pending = await observation(a);
  const other = await observation(b);
  const { run } = await a.createRun({ ...input, idempotency_key: "running" }, [target], estimate);
  const running = (await a.getResults({ run_id: run.id })).observations[0];
  if (!running) throw new Error("Missing observation");
  await a.markQueued(pending.id);
  await b.markQueued(other.id);
  await a.markQueued(running.id);
  await a.claim(running.id, "a");
  expect(await a.resetPendingQueue()).toBe(1);
  expect(await a.resetPendingQueue()).toBe(0);
  expect((await a.listUnqueued()).map((row) => row.id)).toEqual([pending.id]);
  expect(await b.listUnqueued()).toEqual([]);
  expect((await a.getObservation(running.id))?.status).toBe("running");
});
