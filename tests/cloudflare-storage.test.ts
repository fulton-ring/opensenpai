import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { noopObserve } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { createApplication } from "../apps/server/src/application.js";
import { targetSchema } from "../packages/core/src/contracts.js";

async function workerScript() {
  const output = await build({
    stdin: {
      resolveDir: resolve("."),
      contents: `
        import { DurableObject } from "cloudflare:workers";
        import { createDurableResearchStore } from "./packages/core/src/storage/durable-sql.ts";
        import { createResearchRpc, handlePrivateStorage } from "./apps/cloudflare/src/private-storage.ts";
        export class TestResearch extends DurableObject {
          constructor(ctx, env) {
            super(ctx, env);
            this.rpc = createResearchRpc(createDurableResearchStore(ctx.storage, "native-test"));
          }
          researchRpc(body) { return this.rpc(body); }
          async fetch(request) {
            const { sql } = await request.json();
            return Response.json([...this.ctx.storage.sql.exec(sql)]);
          }
        }
        export default { fetch(request, env) {
          const id = env.APPLICATION.idFromName("native-test");
          if (new URL(request.url).pathname === "/fixture-sql")
            return env.APPLICATION.get(id).fetch(request);
          return handlePrivateStorage(request, env, { containerId: id.toString() });
        } };
      `,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    write: false,
  });
  return output.outputFiles[0]?.text ?? "";
}

const env = {
  STORAGE_BACKEND: "cloudflare",
  ROLE: "api",
  OBSERVATION_DISPATCH_MODE: "external",
  WORKSPACE_ID: "native-test",
  MCP_AUTH_TOKEN: "native-durable-mcp-token",
  INTERNAL_EXECUTION_TOKEN: "native-durable-internal-token",
  OPENROUTER_API_KEY: "unused-fixture-key",
  DATABASE_URL: "unsupported:never-open-libsql",
  MASTRA_STORAGE_URL: "unsupported:never-open-libsql",
};
const target = targetSchema.parse({
  id: "fixture",
  transport: "openrouter",
  model: "fixture",
  search: { mode: "off" },
  pricing: { input_per_million: 1, output_per_million: 1 },
});

it("persists MCP results and native Mastra metadata in real Cloudflare SQL stores across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensenpai-native-"));
  const script = await workerScript();
  const options = convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-10-17",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { APPLICATION: { className: "TestResearch", useSQLite: true } },
    d1Databases: { DB: "11111111-1111-1111-1111-111111111111" },
    resourcePersistencePath: directory,
  });
  let mf = new Miniflare(options);
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let client: MCPClient | undefined;
  const bridgeFetch = async (url: string, init: RequestInit) => {
    const response = await mf.dispatchFetch(url, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: String(init.body),
    });
    return new Response(await response.text(), { status: response.status });
  };
  try {
    app = await createApplication(env, { targets: [target], bridgeFetch, port: 0 });
    client = new MCPClient({
      id: "native-storage",
      servers: {
        research: {
          url: new URL(`http://127.0.0.1:${app.port}/mcp`),
          allowedHosts: [`127.0.0.1:${app.port}`],
          requestInit: { headers: { Authorization: `Bearer ${env.MCP_AUTH_TOKEN}` } },
        },
      },
    });
    const tools = await client.listTools();
    expect(Object.keys(tools)).toHaveLength(7);
    const input = {
      prompts: [{ id: "p", text: "Fulton Ring research fixture" }],
      targets: ["fixture"],
      idempotency_key: "durable-mcp",
      max_estimated_cost_usd: 1,
    };
    const started = await tools.research_start_run?.execute?.(input, { observe: noopObserve });
    expect(started).not.toHaveProperty("error");
    const [run] = await app.store.listRuns();
    if (!run) throw new Error("Missing durable run");
    const [observation] = (await app.store.getResults({ run_id: run.id })).observations;
    if (!observation) throw new Error("Missing durable observation");
    const sql = async (query: string) => {
      const response = await mf.dispatchFetch("http://fixture/fixture-sql", {
        method: "POST",
        body: JSON.stringify({ sql: query }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    };
    await sql(
      "CREATE TRIGGER fail_claim BEFORE UPDATE ON app_observations BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
    );
    await expect(app.store.claim(observation.id, "rollback")).rejects.toMatchObject({
      code: "STORAGE_ERROR",
    });
    expect((await app.store.getObservation(observation.id))?.status).toBe("pending");
    expect(await sql("SELECT COUNT(*) n FROM app_attempts")).toEqual([{ n: 0 }]);
    await sql("DROP TRIGGER fail_claim");
    const claims = await Promise.all([
      app.store.claim(observation.id, "a"),
      app.store.claim(observation.id, "b"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const attempt = claims.find(Boolean)?.attempt_id;
    if (!attempt) throw new Error("Missing durable claim");
    expect((await app.store.getRun(run.id))?.reserved_cost_usd).toBeGreaterThan(0);
    const workflows = await app.runtime.mastra.getStorage()?.getStore("workflows");
    const snapshot = {
      runId: run.id,
      status: "success" as const,
      value: {},
      context: {},
      serializedStepGraph: [],
      activePaths: [],
      activeStepsPath: {},
      suspendedPaths: {},
      resumeLabels: {},
      waitingPaths: {},
      timestamp: Date.now(),
    };
    await workflows?.persistWorkflowSnapshot({
      workflowName: "native-fixture",
      runId: run.id,
      snapshot,
    });
    await client.disconnect();
    client = undefined;
    await app.close();
    app = undefined;
    await mf.dispose();
    mf = new Miniflare(options);
    app = await createApplication(env, { targets: [target], bridgeFetch, listen: false });
    expect((await app.store.getRun(run.id))?.reserved_cost_usd).toBeGreaterThan(0);
    expect((await app.store.getObservation(observation.id))?.status).toBe("running");
    expect(await app.store.listToolCalls(run.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: "start_run" })]),
    );
    const restored = await app.runtime.mastra.getStorage()?.getStore("workflows");
    expect(
      await restored?.loadWorkflowSnapshot({ workflowName: "native-fixture", runId: run.id }),
    ).toEqual(snapshot);
    await app.store.markDispatched(observation.id, attempt);
    await app.store.succeed(observation.id, attempt, {
      answer: "Persisted Cloudflare evidence",
      requested_model: "fixture",
      model: "fixture",
      serving_provider: null,
      response_id: "native-response",
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
        estimated_cost_usd: 0.001,
        reported_cost_usd: 0.000002,
        raw: { immutable: true },
      },
      raw_response: { immutable: true },
      warnings: [],
    });
    await app.close();
    app = await createApplication(env, { targets: [target], bridgeFetch, listen: false });
    expect(
      (await app.store.getResults({ run_id: run.id, include_raw: true })).observations[0],
    ).toMatchObject({
      status: "succeeded",
      result: { answer: "Persisted Cloudflare evidence", raw_response: { immutable: true } },
    });
    expect(await app.store.getRun(run.id)).toMatchObject({
      reserved_cost_usd: 0,
      reported_cost_usd: 0.000002,
    });
  } finally {
    await client?.disconnect();
    await app?.close();
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
