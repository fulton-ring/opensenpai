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
  it("advertises exactly seven research tools with bounded inputs and no execution escape hatch", async () => {
    const mcp = createResearchMcp(service());
    const list = await mcp.getToolListInfo();
    expect(list.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_run",
      "estimate_run",
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
