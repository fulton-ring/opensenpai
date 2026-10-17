import { describe, expect, it } from "vitest";
import {
  type Observation,
  type RunRecord,
  runInputSchema,
  targetSchema,
} from "../src/contracts.js";
import { ResearchService, type ServiceStore } from "../src/service.js";

const target = targetSchema.parse({
  id: "test",
  transport: "openai",
  model: "gpt-test",
  search: { mode: "off" },
  pricing: { input_per_million: 1, output_per_million: 2 },
});
const input = runInputSchema.parse({
  prompts: [{ id: "p", text: "hello" }],
  targets: ["test"],
  idempotency_key: "same",
});
function setup(env: Record<string, string | undefined> = { OPENAI_API_KEY: "test-key" }) {
  let saved: RunRecord | undefined;
  let creates = 0;
  let queued = false;
  const dispatched: Observation[][] = [];
  const audits: string[] = [];
  const store: ServiceStore = {
    async createRun(value, _targets, estimate) {
      creates++;
      const created = !saved;
      saved ??= {
        id: "run-1",
        workspace_id: "local",
        input: value,
        status: "queued",
        cancel_requested: false,
        total: 1,
        counts: {
          pending: 1,
          running: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          unknown_outcome: 0,
        },
        estimated_cost_usd: estimate.estimated_cost_usd,
        reported_cost_usd: 0,
        reserved_cost_usd: 0,
        created_at: "now",
        updated_at: "now",
      };
      return { run: saved, created };
    },
    async listUnqueued(_limit, runId) {
      return !queued && saved && (!runId || runId === saved.id)
        ? [{ id: "observation-1", run_id: saved.id, status: "pending" } as Observation]
        : [];
    },
    async getRun() {
      return saved ?? null;
    },
    async listRuns() {
      return saved ? [saved] : [];
    },
    async getResults() {
      return { observations: [], next_cursor: null };
    },
    async cancelRun() {
      return saved ?? null;
    },
    async recordToolCall(tool) {
      audits.push(tool);
    },
  };
  const service = new ResearchService({
    store,
    runtime: {
      async dispatch(values) {
        dispatched.push(values);
        queued = true;
      },
      async cancel() {},
    },
    targets: [target],
    env,
  });
  return { service, creates: () => creates, dispatched, audits };
}
describe("run service boundaries", () => {
  it("validates every selected target before creating a run", async () => {
    const test = setup({});
    await expect(test.service.startRun(input)).rejects.toMatchObject({
      code: "TARGET_UNAVAILABLE",
    });
    expect(test.creates()).toBe(0);
  });
  it("rejects unpriced targets with a budget before storing", async () => {
    const test = setup();
    const service = new ResearchService({
      ...test.service.options,
      targets: [{ ...target, pricing: undefined }],
    });
    await expect(service.startRun({ ...input, max_estimated_cost_usd: 1 })).rejects.toMatchObject({
      code: "UNPRICED_TARGET",
    });
    expect(test.creates()).toBe(0);
  });
  it("reuses idempotent run identity and audits writes and reads", async () => {
    const test = setup();
    expect((await test.service.startRun(input)).created).toBe(true);
    expect((await test.service.startRun(input)).created).toBe(false);
    expect((await test.service.getRun({ run_id: "run-1", wait_ms: 0 })).id).toBe("run-1");
    expect(test.audits).toEqual(["start_run", "start_run", "get_run"]);
  });
  it("rejects unknown targets before storing", async () => {
    const test = setup();
    await expect(test.service.startRun({ ...input, targets: ["missing"] })).rejects.toMatchObject({
      code: "UNKNOWN_TARGET",
    });
    expect(test.creates()).toBe(0);
  });
  it("does not re-enqueue observations already submitted on an idempotent retry", async () => {
    const test = setup();
    await test.service.startRun(input);
    await test.service.startRun(input);
    expect(test.dispatched).toHaveLength(1);
    expect(test.dispatched[0]?.map(({ id }) => id)).toEqual(["observation-1"]);
  });
  it("rejects over-budget estimates before storage", async () => {
    const test = setup();
    await expect(
      test.service.startRun({ ...input, max_estimated_cost_usd: 0.000000001 }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(test.creates()).toBe(0);
  });
  it("reports observed search and citation capabilities from durable completed results", async () => {
    const test = setup();
    await test.service.startRun(input);
    test.service.options.store.getResults = async () => ({
      observations: [
        {
          target,
          status: "succeeded",
          updated_at: "observed-now",
          result: {
            model: "served-model",
            serving_provider: "provider",
            search_activity: { requested: "off", observed: "not_observed", engine: null },
            citations: [{ url: "https://example.com" }],
            sources: [],
          },
        } as unknown as Observation,
      ],
      next_cursor: null,
    });
    const result = await test.service.listTargets();
    expect(result.targets[0]?.observed_capabilities).toMatchObject({
      model: "served-model",
      citation_count: 1,
      observed_at: "observed-now",
    });
  });
});
