import type { OutboundHandlerContext } from "@cloudflare/containers";
import { ResearchError } from "@opensenpai/core/contracts";
import type { ResearchStorage } from "@opensenpai/core/storage";
import { describe, expect, it } from "vitest";
import { createResearchRpc, handlePrivateStorage } from "../src/private-storage.js";

function request(path: string, body: unknown, method = "POST") {
  return new Request(`http://cloudflare-storage${path}`, {
    method,
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function binding() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const result = { success: true, results: [{ value: "persisted" }], meta: { changes: 1 } };
  const DB = {
    prepare(sql: string) {
      const query = { sql, params: [] as unknown[] };
      queries.push(query);
      return {
        bind(...params: unknown[]) {
          query.params = params;
          return this;
        },
        all: async () => result,
      };
    },
  } as unknown as D1Database;
  const owners: string[] = [];
  const calls: unknown[] = [];
  const APPLICATION = {
    idFromString: (id: string) => ({ toString: () => id }) as DurableObjectId,
    get(id: DurableObjectId) {
      owners.push(id.toString());
      return {
        async researchRpc(body: unknown) {
          calls.push(body);
          return { result: "research" };
        },
      };
    },
  };
  return { env: { DB, APPLICATION }, queries, result, owners, calls };
}
const context = {
  containerId: "owning-object",
  className: "OpenSenpaiContainer",
} satisfies OutboundHandlerContext;

describe("private Cloudflare storage bridge", () => {
  it("executes D1 prepared queries and preserves the native D1 result envelope", async () => {
    const state = binding();
    const response = await handlePrivateStorage(
      request("/d1", { sql: "SELECT ?", params: ["x"] }),
      state.env,
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: [state.result] });
    expect(state.queries).toEqual([{ sql: "SELECT ?", params: ["x"] }]);
  });

  it("routes research through the current owning Durable Object without accepting a workspace", async () => {
    const state = binding();
    const body = { method: "getRun", args: ["run-1"] };
    expect(
      await (await handlePrivateStorage(request("/research", body), state.env, context)).json(),
    ).toEqual({ result: "research" });
    expect(state.owners).toEqual(["owning-object"]);
    expect(state.calls).toEqual([body]);
  });

  it.each([
    ["/d1", null],
    ["/d1", { sql: "", params: [] }],
    ["/d1", { sql: "SELECT ?", params: [{}] }],
    ["/d1", { sql: "SELECT ?", params: [true] }],
    ["/d1", { sql: "SELECT 1", params: [], workspaceId: "other" }],
    ["/research", { method: "client", args: [] }],
    ["/research", { method: "close", args: [] }],
    ["/research", { method: "getRun", args: "run-1" }],
    ["/research", { method: "getRun", args: ["run-1"], workspaceId: "other" }],
  ])("rejects malformed %s payload %j without storage access", async (path, body) => {
    const state = binding();
    const response = await handlePrivateStorage(request(path, body), state.env, context);
    expect(response.status).toBe(400);
    expect(state.queries).toEqual([]);
    expect(state.owners).toEqual([]);
  });

  it("rejects wrong methods, paths, hosts and invalid JSON", async () => {
    const state = binding();
    for (const req of [
      request("/d1", {}, "GET"),
      request("/other", {}),
      new Request("http://example.com/d1", { method: "POST", body: "{}" }),
    ]) {
      expect((await handlePrivateStorage(req, state.env, context)).ok).toBe(false);
    }
    const invalid = new Request("http://cloudflare-storage/research", {
      method: "POST",
      body: "{",
    });
    expect((await handlePrivateStorage(invalid, state.env, context)).status).toBe(400);
    expect(state.queries).toEqual([]);
    expect(state.owners).toEqual([]);
  });

  it("does not report success when the D1 binding returns a failed result", async () => {
    const state = binding();
    state.env.DB.prepare = () =>
      ({
        bind() {
          return this;
        },
        all: async () => ({ success: false, error: "secret D1 error" }),
      }) as unknown as D1PreparedStatement;
    const response = await handlePrivateStorage(
      request("/d1", { sql: "SELECT 1", params: [] }),
      state.env,
      context,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });

  it("sanitizes D1 failures without including SQL or internal exception details", async () => {
    const state = binding();
    state.env.DB.prepare = () => {
      throw new Error("secret SQL database detail");
    };
    const response = await handlePrivateStorage(
      request("/d1", { sql: "SELECT 1", params: [] }),
      state.env,
      context,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });
});

describe("research RPC dispatch", () => {
  it("awaits a single initialization before concurrent operations and preserves receiver", async () => {
    let finish = () => {};
    const events: string[] = [];
    const store = {
      workspaceId: "trusted",
      initialize: () =>
        new Promise<void>((resolve) => {
          events.push("initialize");
          finish = resolve;
        }),
      async getRun(id: string) {
        events.push(this.workspaceId);
        return { id };
      },
    };
    const rpc = createResearchRpc(store as unknown as ResearchStorage);
    const first = rpc({ method: "getRun", args: ["first"] });
    const second = rpc({ method: "getRun", args: ["second"] });
    expect(events).toEqual(["initialize"]);
    finish();
    expect(await first).toEqual({ result: { id: "first" } });
    expect(await second).toEqual({ result: { id: "second" } });
    expect(events).toEqual(["initialize", "trusted", "trusted"]);
    expect(await rpc({ method: "initialize", args: [] })).toEqual({ result: null });
    expect(events.filter((event) => event === "initialize")).toHaveLength(1);
  });

  it("returns business errors and sanitizes unexpected errors", async () => {
    const store = {
      async initialize() {},
      async getRun(id: string) {
        if (id === "business")
          throw new ResearchError("IDEMPOTENCY_CONFLICT", "Different input", false);
        throw new Error("secret database internals");
      },
    } as unknown as ResearchStorage;
    const rpc = createResearchRpc(store);
    expect(await rpc({ method: "getRun", args: ["business"] })).toEqual({
      error: { code: "IDEMPOTENCY_CONFLICT", message: "Different input", retryable: false },
    });
    expect(await rpc({ method: "getRun", args: ["unexpected"] })).toEqual({
      error: {
        code: "STORAGE_ERROR",
        message: "Research storage operation failed",
        retryable: false,
      },
    });
    expect(await rpc({ method: "client", args: [] })).toMatchObject({
      error: { code: "INVALID_STORAGE_REQUEST", retryable: false },
    });
  });

  it("restores omitted optional RPC arguments without changing nested null values", async () => {
    let received: unknown[] = [];
    const store = {
      async initialize() {},
      async failRetrieval(...args: unknown[]) {
        received = args;
      },
    } as unknown as ResearchStorage;
    const rpc = createResearchRpc(store);
    const failure = {
      code: "not_dispatched",
      message: "Stopped",
      retryable: false,
      metadata: null,
    };
    expect(
      await rpc({
        method: "failRetrieval",
        args: ["retrieval", "owner", failure, false, null, true],
      }),
    ).toEqual({ result: null });
    expect(received).toEqual(["retrieval", "owner", failure, false, undefined, true]);
  });

  it("does not execute operations after failed initialization and retries setup on the next call", async () => {
    let attempts = 0;
    let reads = 0;
    const store = {
      async initialize() {
        if (++attempts === 1) throw new Error("setup failed");
      },
      async getRun() {
        reads++;
        return null;
      },
    } as unknown as ResearchStorage;
    const rpc = createResearchRpc(store);
    expect(await rpc({ method: "getRun", args: ["run"] })).toMatchObject({
      error: { code: "STORAGE_ERROR" },
    });
    expect(reads).toBe(0);
    expect(await rpc({ method: "getRun", args: ["run"] })).toEqual({ result: null });
    expect(attempts).toBe(2);
    expect(reads).toBe(1);
  });
});
