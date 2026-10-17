import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer, type HttpOptions } from "../src/http.js";

const token = "public-token-at-least-16";
const internal = "internal-token-at-least-16";
const servers: ReturnType<typeof createHttpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
});
async function setup(
  status = "succeeded",
  role: "all" | "api" | "worker" = "all",
  executeThrows = false,
) {
  let calls = 0;
  const options = {
    mcpToken: token,
    internalToken: internal,
    role,
    host: "127.0.0.1",
    mcp: {
      async startHTTP({ res }: { res: import("node:http").ServerResponse }) {
        calls++;
        res.end("native");
      },
    },
    store: {
      async listToolCalls() {
        return [{ tool: "get_run", run_id: "r", created_at: "now" }];
      },
      async getRun() {
        return { id: "r" };
      },
      async getResults() {
        return { observations: [], next_cursor: null };
      },
      async listUnqueued() {
        return [{ id: "o" }];
      },
      async markQueued() {},
      async getObservation() {
        return { id: "o", status };
      },
    },
    runtime: {
      async executeObservation() {
        calls++;
        if (executeThrows) throw new Error("provider runtime error with secret details");
      },
    },
  } as unknown as HttpOptions;
  const server = createHttpServer(options);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    server,
  };
}
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });
describe("HTTP authentication and queue durability", () => {
  it("protects MCP and audit while exposing public liveness", async () => {
    const test = await setup();
    expect((await fetch(`${test.url}/health`)).status).toBe(200);
    expect((await fetch(`${test.url}/mcp`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${test.url}/internal/audit`)).status).toBe(401);
    const response = await fetch(`${test.url}/internal/audit?run_id=r`, { headers: auth(token) });
    expect(await response.json()).toMatchObject({ toolCalls: [{ tool: "get_run" }] });
    expect(test.calls()).toBe(0);
  });
  it("denies execution to the public MCP token and accepts only distinct internal token", async () => {
    const test = await setup();
    expect(
      (
        await fetch(`${test.url}/internal/observations/o/execute`, {
          method: "POST",
          headers: auth(token),
        })
      ).status,
    ).toBe(401);
    expect(test.calls()).toBe(0);
    expect(
      (
        await fetch(`${test.url}/internal/observations/o/execute`, {
          method: "POST",
          headers: auth(internal),
        })
      ).status,
    ).toBe(200);
    expect(test.calls()).toBe(1);
  });
  it.each(["pending", "running"])(
    "does not acknowledge nonterminal %s observations",
    async (status) => {
      const test = await setup(status, "all", true);
      const response = await fetch(`${test.url}/internal/observations/o/execute`, {
        method: "POST",
        headers: auth(internal),
      });
      expect(response.status).toBe(409);
    },
  );
  it("rejects hostile origins and oversized requests before native MCP", async () => {
    const test = await setup();
    expect(
      (
        await fetch(`${test.url}/mcp`, {
          method: "POST",
          headers: {
            ...auth(token),
            Origin: "https://evil.example",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${test.url}/mcp`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: " ".repeat(1_048_577),
        })
      ).status,
    ).toBe(413);
    expect(test.calls()).toBe(0);
  });
  it.each(["failed", "cancelled", "unknown_outcome"])(
    "acknowledges durable terminal %s even when execution reports an error",
    async (status) => {
      const test = await setup(status, "all", true);
      const response = await fetch(`${test.url}/internal/observations/o/execute`, {
        method: "POST",
        headers: auth(internal),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "o", status });
    },
  );
  it("keeps worker health private and does not serve MCP", async () => {
    const test = await setup("succeeded", "worker");
    expect((await fetch(`${test.url}/health`)).status).toBe(401);
    expect((await fetch(`${test.url}/health`, { headers: auth(internal) })).status).toBe(200);
    expect((await fetch(`${test.url}/mcp`, { headers: auth(token) })).status).toBe(404);
    expect(test.calls()).toBe(0);
  });
});
