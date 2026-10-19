import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ResearchError } from "@opensenpai/core/contracts";
import type { ResearchService } from "@opensenpai/core/service";
import { describe, expect, it } from "vitest";
import { createResearchMcp } from "../src/mcp.js";

function service() {
  return {
    async listTargets() {
      return { targets: [] };
    },
    async estimateRun() {
      return { total_observations: 1 };
    },
    async startRun() {
      throw new ResearchError("TARGET_UNAVAILABLE", "Configure the target credentials.");
    },
    async getRun() {
      return { id: "run-1", status: "succeeded" };
    },
    async getResults() {
      return { observations: [], next_cursor: null };
    },
    async listRuns() {
      return { runs: [] };
    },
    async cancelRun() {
      throw new Error("SECRET_CREDENTIAL must never escape");
    },
  } as unknown as ResearchService;
}
describe("native MCP tools", () => {
  it("accepts model discovery through MCP rather than requiring preset aliases", async () => {
    const research = service();
    research.listTargets = async (query) => ({ query }) as never;
    const mcp = createResearchMcp(research);
    try {
      expect(
        await mcp.executeTool("list_targets", {
          provider: "openrouter",
          model_query: "glm",
          limit: 5,
        }),
      ).toMatchObject({
        output: { query: { provider: "openrouter", model_query: "glm", limit: 5 } },
      });
    } finally {
      await mcp.close();
    }
  });
  it("advertises exactly six research tools with bounded inputs and no execution escape hatch", async () => {
    const mcp = createResearchMcp(service());
    const list = await mcp.getToolListInfo();
    expect(list.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_run",
      "get_results",
      "get_run",
      "list_runs",
      "list_targets",
      "start_run",
    ]);
    expect(JSON.stringify(mcp.getToolInfo("get_run")?.inputSchema)).toContain('"maximum":10000');
    expect(mcp.getToolInfo("get_results")?.inputSchema).toMatchObject({
      properties: { include_raw: { default: false } },
    });
    expect(mcp.getToolInfo("list_runs")?.inputSchema).toMatchObject({
      properties: { cursor: { type: "string", maxLength: 1000 }, before: { type: "string" } },
    });
    await mcp.close();
  });
  it("executes native tools and returns structured actionable errors without secret stacks", async () => {
    const mcp = createResearchMcp(service());
    const result = await mcp.executeTool("list_targets", {});
    expect(result).toMatchObject({ output: { targets: [] } });
    const error = await mcp.executeTool("cancel_run", { run_id: "run-1" });
    expect(JSON.stringify(error)).not.toContain("SECRET_CREDENTIAL");
    expect(error).toMatchObject({
      output: { error: { code: "INTERNAL_ERROR", retryable: false } },
    });
    await mcp.close();
  });
});

it.each(["2025-03-26", "2025-06-18", "2025-11-25"])(
  "serves the %s handshake and tools through the native HTTP transport",
  async (protocolVersion) => {
    const mcp = createResearchMcp(service());
    const server = createServer((req, res) => {
      void mcp.startHTTP({
        url: new URL(req.url ?? "/", "http://localhost"),
        httpPath: "/mcp",
        req,
        res,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    async function rpc(method: string, params: unknown = {}, id: number | undefined = 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(protocolVersion === "2025-03-26" ? {} : { "mcp-protocol-version": protocolVersion }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      const text = await response.text();
      const data = text.startsWith("event:")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
        : text;
      return { status: response.status, body: data ? JSON.parse(data) : null };
    }
    try {
      expect(
        await rpc("initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "claude-compatible-test", version: "1.0.0" },
        }),
      ).toMatchObject({ status: 200, body: { result: { protocolVersion } } });
      expect(await rpc("tools/list")).toMatchObject({
        status: 200,
        body: {
          result: {
            tools: expect.arrayContaining([expect.objectContaining({ name: "list_targets" })]),
          },
        },
      });
      expect(await rpc("tools/call", { name: "list_targets", arguments: {} })).toMatchObject({
        status: 200,
        body: {
          result: { content: [{ type: "text", text: expect.stringContaining('"targets":[]') }] },
        },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mcp.close();
    }
  },
);

it("omits forecast costs while retaining actual charges and source evidence", async () => {
  const research = service();
  research.getResults = async () =>
    ({
      observations: [
        {
          estimated_cost_usd: 0.2,
          result: {
            answer: "Evidence",
            citations: [{ url: "https://example.com/cited" }],
            sources: [{ url: "https://example.com/retrieved" }],
            usage: { reported_cost_usd: 0.01, estimated_cost_usd: 0.02 },
            raw_response: { estimated_cost_usd: 0.03 },
          },
        },
      ],
    }) as never;
  const mcp = createResearchMcp(research);
  try {
    const result = await mcp.executeTool("get_results", { run_id: "run-1" });
    expect(result).toMatchObject({
      output: {
        observations: [
          {
            result: {
              citations: [{ url: "https://example.com/cited" }],
              sources: [{ url: "https://example.com/retrieved" }],
              usage: { reported_cost_usd: 0.01 },
              raw_response: { estimated_cost_usd: 0.03 },
            },
          },
        ],
      },
    });
    if (!("output" in result)) throw new Error("Expected completed MCP result");
    const observations = (
      result.output as {
        observations: { estimated_cost_usd?: number; result: { usage: object } }[];
      }
    ).observations;
    expect(observations[0]).not.toHaveProperty("estimated_cost_usd");
    expect(observations[0]?.result.usage).not.toHaveProperty("estimated_cost_usd");
  } finally {
    await mcp.close();
  }
});
