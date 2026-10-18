import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, expect, it } from "vitest";
import { type RunInput, runInputSchema, type Target } from "../../src/contracts.js";
import type { ProviderRegistry } from "../../src/providers/types.js";
import { ResearchService } from "../../src/service.js";
import { ResearchStore } from "../../src/storage/index.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
});
const input = runInputSchema.parse({
  prompts: [{ id: "p", text: "Research" }],
  targets: [{ id: "inline", provider: "custom", model: "custom/model", search: { mode: "off" } }],
  idempotency_key: "retry",
  max_estimated_cost_usd: 1,
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "idempotent-metadata-"));
  const store = new ResearchStore(
    createClient({ url: `file:${join(directory, "research.db")}` }),
    "first",
  );
  await store.initialize();
  let calls = 0;
  let price = 1;
  let route = "first-route";
  let unavailable = false;
  let outage = false;
  const providers: ProviderRegistry = {
    models: {
      custom: {
        availability: () => ({ available: !unavailable }),
        resolveTarget: async (target) => {
          calls++;
          if (outage) throw new Error("catalog unavailable");
          return {
            ...target,
            pricing: { input_per_million: price, output_per_million: price, search_per_request: 0 },
            provider_options: { provider: route },
          };
        },
        execute: async () => {
          throw new Error("No paid call expected");
        },
      },
    },
    retrievals: {},
  };
  const service = new ResearchService({
    store,
    providers,
    targets: [],
    env: {},
    dispatchMode: "external",
    runtime: { dispatch: async () => {}, cancel: async () => {} },
  });
  close.push(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    service,
    providers,
    directory,
    calls: () => calls,
    setPrice: (value: number) => {
      price = value;
    },
    setRoute: (value: string) => {
      route = value;
    },
    unavailable: () => {
      unavailable = true;
    },
    outage: () => {
      outage = true;
    },
  };
}
it("replays accepted inline input without catalog, key or availability checks and preserves its first target snapshot", async () => {
  const f = await fixture();
  const first = await f.service.startRun(input);
  f.setPrice(10_000_000);
  f.setRoute("changed-route");
  expect(await f.service.startRun(input)).toMatchObject({
    created: false,
    run: { id: first.run.id },
  });
  f.unavailable();
  f.outage();
  expect(await f.service.startRun(input)).toMatchObject({
    created: false,
    run: { id: first.run.id },
  });
  expect(f.calls()).toBe(1);
  const [observation] = (await f.store.getResults({ run_id: first.run.id })).observations;
  expect(observation?.target).toMatchObject({
    provider_options: { provider: "first-route" },
    pricing: { input_per_million: 1 },
  });
});
it("rejects changed caller input before catalog resolution even during a provider outage", async () => {
  const f = await fixture();
  await f.service.startRun(input);
  f.outage();
  await expect(f.service.startRun({ ...input, locale: "fr" })).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
  expect(f.calls()).toBe(1);
});
it("keeps a replay lookup scoped to the store workspace", async () => {
  const f = await fixture();
  const { run } = await f.service.startRun(input);
  const other = new ResearchStore(
    createClient({ url: `file:${join(f.directory, "research.db")}` }),
    "second",
  );
  close.unshift(async () => other.close());
  expect(await other.getRunByIdempotencyKey(input.idempotency_key)).toBeNull();
  expect((await f.store.getRunByIdempotencyKey(input.idempotency_key))?.id).toBe(run.id);
});
it("accepts concurrent matching input once and preserves the winning price and route", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const secondEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releaseSecond = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolutions = 0;
  const adapter = f.providers.models.custom;
  if (!adapter) throw new Error("Missing custom adapter");
  Object.assign(adapter, {
    resolveTarget: async (target: Target) => {
      const revision = ++resolutions;
      if (revision === 2) {
        entered();
        await releaseSecond;
      }
      return {
        ...target,
        pricing: {
          input_per_million: revision,
          output_per_million: revision,
          search_per_request: 0,
        },
        provider_options: { provider: revision === 1 ? "first-route" : "second-route" },
      };
    },
  });
  const first = f.service.startRun(input);
  const second = f.service.startRun(input);
  await secondEntered;
  const accepted = await first;
  release();
  const replay = await second;
  expect(accepted.created).toBe(true);
  expect(replay).toMatchObject({ created: false, run: { id: accepted.run.id } });
  expect(
    (await f.store.getResults({ run_id: accepted.run.id })).observations[0]?.target,
  ).toMatchObject({
    pricing: { input_per_million: 1 },
    provider_options: { provider: "first-route" },
  });
  expect(await f.store.listRuns()).toHaveLength(1);
});
it("compares stored caller input for legacy rows rather than relying on their input hash", async () => {
  const f = await fixture();
  const { run } = await f.service.startRun(input);
  await f.store.client.execute({
    sql: "UPDATE app_runs SET input_hash=? WHERE workspace_id=? AND id=?",
    args: ["legacy-snapshot-hash", "first", run.id],
  });
  const [observation] = (await f.store.getResults({ run_id: run.id })).observations;
  if (!observation) throw new Error("Missing accepted target");
  const changedTarget = { ...observation.target, model: "changed-operator-model" };
  const estimate = await f.service.estimateRun(input);
  expect(await f.store.createRun(input, [changedTarget], estimate)).toMatchObject({
    created: false,
    run: { id: run.id },
  });
  await expect(
    f.store.createRun({ ...input, locale: "fr" } as RunInput, [changedTarget], estimate),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
