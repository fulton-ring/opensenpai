import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
  ContainerProxy: class {},
  getContainer: vi.fn(),
}));

import { ContainerProxy, OpenSenpaiContainer } from "../src/worker.js";

function container() {
  const queries: { sql: string; args: unknown[] }[] = [];
  let transactions = 0;
  const storage = {
    sql: {
      exec(sql: string, ...args: unknown[]) {
        queries.push({ sql, args });
        return { columnNames: [], [Symbol.iterator]: function* () {} };
      },
    },
    async transaction<T>(operation: () => Promise<T>) {
      transactions++;
      return operation();
    },
  };
  const application = new OpenSenpaiContainer(
    { storage } as unknown as ConstructorParameters<typeof OpenSenpaiContainer>[0],
    {
      WORKSPACE_ID: "trusted-workspace",
      MCP_AUTH_TOKEN: "mcp-secret",
      INTERNAL_EXECUTION_TOKEN: "internal-secret",
    } as unknown as ConstructorParameters<typeof OpenSenpaiContainer>[1],
  );
  return { application, queries, transactions: () => transactions };
}

describe("owning Container Durable Object storage", () => {
  it("registers private outbound storage and exports the required Container proxy", () => {
    const state = container();
    expect(ContainerProxy).toBeDefined();
    expect(OpenSenpaiContainer.outboundByHost?.["cloudflare-storage"]).toBeTypeOf("function");
    expect(state.application.envVars).toMatchObject({ STORAGE_BACKEND: "cloudflare" });
  });

  it("uses the durable storage and trusted environment workspace for research RPC", async () => {
    const state = container();
    expect(await state.application.researchRpc({ method: "getRun", args: ["run-1"] })).toEqual({
      result: null,
    });
    expect(await state.application.researchRpc({ method: "getRun", args: ["run-2"] })).toEqual({
      result: null,
    });
    expect(state.transactions()).toBe(1);
    expect(
      state.queries
        .filter((query) => query.sql.includes("FROM app_runs"))
        .map((query) => query.args),
    ).toEqual([
      ["trusted-workspace", "run-1"],
      ["trusted-workspace", "run-2"],
    ]);
  });
});
