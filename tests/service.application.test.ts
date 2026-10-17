import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopObserve } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import { describe, expect, it } from "vitest";
import { createApplication } from "../src/application.js";

it("validates configuration before connecting to storage", async () => {
  await expect(
    createApplication({}, { databaseUrl: "file:/not/writable/never.db" }),
  ).rejects.toThrow(/MCP_AUTH_TOKEN/);
});
it("rejects native split roles without shared durable infrastructure", async () => {
  const env = { MCP_AUTH_TOKEN: "test-token-long-enough" };
  await expect(
    createApplication(env, { role: "api", databaseUrl: "file:/never-created/missing.db" }),
  ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await expect(
    createApplication(
      { ...env, VALKEY_URL: "redis://localhost:6379" },
      { role: "api", databaseUrl: "file:/never-created/missing.db" },
    ),
  ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
});
describe("application composition", () => {
  it("starts native MCP with durable stores and no provider credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensenpai-app-"));
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      app = await createApplication(
        {
          MCP_AUTH_TOKEN: "test-token-long-enough",
          INTERNAL_EXECUTION_TOKEN: "internal-token-long-enough",
          OBSERVATION_DISPATCH_MODE: "external",
        },
        { databaseUrl: `file:${join(directory, "research.db")}`, port: 0 },
      );
      expect(app.port).toBeGreaterThan(0);
      const result = await app.mcp.executeTool("list_targets", {});
      expect(result.status).toBe("completed");
      const response = await fetch(`http://127.0.0.1:${app.port}/health`);
      expect(response.status).toBe(200);
      expect(app.runtime.mastra.getMCPServer("aeo")).toBe(app.mcp);
      const client = new MCPClient({
        id: "http-protocol-check",
        servers: {
          research: {
            url: new URL(`http://127.0.0.1:${app.port}/mcp`),
            allowedHosts: [`127.0.0.1:${app.port}`],
            requestInit: { headers: { Authorization: "Bearer test-token-long-enough" } },
          },
        },
      });
      try {
        const tools = await client.listTools();
        expect(Object.keys(tools)).toHaveLength(7);
        expect(tools.research_list_targets).toBeDefined();
        const targetList = await tools.research_list_targets?.execute?.(
          {},
          { observe: noopObserve },
        );
        expect(JSON.stringify(targetList)).toContain("openai-native");
      } finally {
        await client.disconnect();
      }

      await app.close();
      await app.close();
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
