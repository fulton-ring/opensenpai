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

import { getContainer } from "@cloudflare/containers";
import worker, { ContainerProxy, OpenSenpaiContainer } from "../src/worker.js";

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

describe("scheduled repair", () => {
  it.each(["idle", "unqueued", "settlement", "usage", "storage failure"])(
    "checks durable state before waking the Node container: %s",
    async (state) => {
      const fetcher = vi.fn(async () => Response.json({ observations: [] }));
      const application = container().application;
      const researchRpc = vi.spyOn(application, "researchRpc").mockImplementation(async (body) => {
        const { method } = body as { method: string };
        if (state === "storage failure")
          return {
            error: { code: "STORAGE_ERROR", message: "storage unavailable", retryable: false },
          };
        if (method === "recoverExpired") return { result: 0 };
        return {
          result:
            (state === "unqueued" && method === "listUnqueued") ||
            (state === "settlement" && method === "listPendingSettlements") ||
            (state === "usage" && method === "listPendingUsageReconciliations")
              ? [{ id: "pending-1" }]
              : [],
        };
      });
      vi.mocked(getContainer).mockReturnValue({
        fetch: fetcher,
        needsRepair: () => application.needsRepair(),
      } as unknown as ReturnType<typeof getContainer>);
      const operation = worker.scheduled(
        {} as ScheduledController,
        { INTERNAL_EXECUTION_TOKEN: "internal-secret" } as Parameters<typeof worker.scheduled>[1],
      );
      if (state === "storage failure") await expect(operation).rejects.toThrow();
      else await operation;
      expect(researchRpc).toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(
        ["unqueued", "settlement", "usage"].includes(state) ? 2 : 0,
      );
    },
  );
});
