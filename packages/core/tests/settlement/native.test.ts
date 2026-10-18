import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { runInputSchema, targetSchema } from "../../src/contracts.js";
import type { ResearchArgs, ResearchMethod, ResearchResult } from "../../src/storage/protocol.js";

async function script() {
  const root = resolve(import.meta.dirname, "../../../..");
  const output = await build({
    stdin: {
      resolveDir: root,
      contents: `
        import { DurableObject } from "cloudflare:workers";
        import { createDurableResearchStore } from "./packages/core/src/storage/durable-sql.ts";
        import { createResearchRpc } from "./apps/cloudflare/src/private-storage.ts";
        export class SettlementStore extends DurableObject {
          constructor(ctx, env) {
            super(ctx, env);
            this.rpc = createResearchRpc(createDurableResearchStore(ctx.storage, "native"));
          }
          async fetch(request) { return Response.json(await this.rpc(await request.json())); }
        }
        export default { fetch(request, env) {
          return env.STORE.get(env.STORE.idFromName("settlements")).fetch(request);
        } };
      `,
    },
    alias: { "@opensenpai/core/storage": join(root, "packages/core/src/storage/index.ts") },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    write: false,
  });
  return output.outputFiles[0]?.text ?? "";
}

it("retains and acknowledges settlement evidence through private RPC after a real Durable Object restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-settlement-"));
  const options = convertV4MiniflareOptions({
    modules: true,
    script: await script(),
    compatibilityDate: "2026-10-17",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { STORE: { className: "SettlementStore", useSQLite: true } },
    resourcePersistencePath: directory,
  });
  let mf = new Miniflare(options);
  const rpc = async <M extends ResearchMethod>(
    method: M,
    ...args: ResearchArgs<M>
  ): Promise<ResearchResult<M>> => {
    const response = await mf.dispatchFetch("http://fixture/", {
      method: "POST",
      body: JSON.stringify({ method, args }),
    });
    const value = (await response.json()) as { result: ResearchResult<M>; error?: unknown };
    expect(value.error).toBeUndefined();
    return value.result;
  };
  try {
    await rpc("initialize");
    const target = targetSchema.parse({
      id: "t",
      transport: "openai",
      model: "test",
      search: { mode: "off" },
    });
    await rpc(
      "createRun",
      runInputSchema.parse({
        prompts: [{ id: "p", text: "hello" }],
        targets: ["t"],
        idempotency_key: "native",
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
    const observation = (await rpc("listPending"))[0];
    if (!observation) throw new Error("Expected observation");
    const claim = await rpc("claim", observation.id, "owner");
    if (!claim?.attempt_id) throw new Error("Expected attempt");
    await rpc(
      "fail",
      observation.id,
      claim.attempt_id,
      { code: "not_sent", message: "not sent", retryable: false },
      "failed",
    );
    const events = await rpc("listPendingSettlements");
    expect(events).toEqual([
      expect.objectContaining({ usage: expect.objectContaining({ reported_cost_usd: 0 }) }),
    ]);
    await mf.dispose();
    mf = new Miniflare(options);
    await rpc("initialize");
    expect(await rpc("listPendingSettlements")).toEqual(events);
    const event = events[0];
    if (!event) throw new Error("Expected event");
    await rpc("ackSettlement", event.id);
    expect(await rpc("listPendingSettlements")).toEqual([]);
    expect((await rpc("getObservation", observation.id))?.status).toBe("failed");
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
