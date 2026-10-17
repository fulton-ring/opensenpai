import { createClient, type InValue } from "@libsql/client";
import { D1Store } from "@mastra/cloudflare-d1";
import { LibSQLStore } from "@mastra/libsql";
import { ResearchError } from "@opensenpai/core/contracts";
import { ResearchStore } from "@opensenpai/core/storage";
import { expect, it } from "vitest";
import { createApplication } from "../src/application.js";

const env = {
  STORAGE_BACKEND: "cloudflare",
  ROLE: "api",
  OBSERVATION_DISPATCH_MODE: "external",
  MCP_AUTH_TOKEN: "cloudflare-mcp-token-long",
  INTERNAL_EXECUTION_TOKEN: "cloudflare-internal-token-long",
  DATABASE_URL: "unsupported:must-not-connect",
  MASTRA_STORAGE_URL: "unsupported:must-not-connect",
};
function bridgeFixture() {
  const research = new ResearchStore(createClient({ url: "file::memory:" }), "local");
  const d1 = createClient({ url: "file::memory:" });
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const bridgeFetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, body });
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    if (url === "http://cloudflare-storage/d1") {
      const result = await d1.execute({ sql: body.sql, args: body.params as InValue[] });
      return Response.json({ result: [{ success: true, results: result.rows }] });
    }
    expect(url).toBe("http://cloudflare-storage/research");
    const method = Reflect.get(research, body.method) as (...args: unknown[]) => Promise<unknown>;
    return Response.json({ result: (await method.apply(research, body.args)) ?? null });
  };
  return { research, d1, requests, bridgeFetch };
}
it("uses the private research bridge and real native D1 initialization and workflow metadata", async () => {
  const f = bridgeFixture();
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createApplication(env, { bridgeFetch: f.bridgeFetch, listen: false });
    const storage = app.runtime.mastra.getStorage();
    expect(storage).toBeInstanceOf(D1Store);
    expect(f.requests.some(({ body }) => body.method === "initialize")).toBe(true);
    expect(f.requests.some(({ body }) => String(body.sql).includes("CREATE TABLE"))).toBe(true);
    expect(await app.store.listRuns()).toEqual([]);
    const workflows = await storage?.getStore("workflows");
    const snapshot = {
      runId: "bridge-run",
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
      workflowName: "bridge",
      runId: "bridge-run",
      snapshot,
    });
    expect(
      await workflows?.loadWorkflowSnapshot({ workflowName: "bridge", runId: "bridge-run" }),
    ).toEqual(snapshot);
    await app.close();
    await app.close();
    expect(f.requests.some(({ body }) => body.method === "close")).toBe(false);
    expect(await f.research.listRuns()).toEqual([]);
  } finally {
    await app?.close();
    await f.research.close();
    f.d1.close();
  }
});
it("retains explicit native storage injection in the Cloudflare profile", async () => {
  const f = bridgeFixture();
  const storage = new LibSQLStore({ id: "injected", url: ":memory:" });
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app = await createApplication(env, { storage, bridgeFetch: f.bridgeFetch, listen: false });
    expect(app.runtime.mastra.getStorage()).toBeInstanceOf(LibSQLStore);
    expect(app.runtime.mastra.getStorage()?.id).toBe(storage.id);
    expect(f.requests.every(({ url }) => url.endsWith("/research"))).toBe(true);
  } finally {
    await app?.close();
    await f.research.close();
    f.d1.close();
  }
});
it("preserves remote research failures without retrying initialization", async () => {
  let requests = 0;
  await expect(
    createApplication(env, {
      listen: false,
      storage: new LibSQLStore({ id: "failed-bridge", url: ":memory:" }),
      bridgeFetch: async () => {
        requests++;
        return Response.json(
          { error: { code: "STORAGE_UNAVAILABLE", message: "durable failure", retryable: true } },
          { status: 503 },
        );
      },
    }),
  ).rejects.toMatchObject(new ResearchError("STORAGE_UNAVAILABLE", "durable failure", true));
  expect(requests).toBe(1);
});
