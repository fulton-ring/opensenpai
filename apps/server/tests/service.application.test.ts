import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
        expect(Object.keys(tools)).toHaveLength(6);
        expect(tools.research_list_targets).toBeDefined();
        const targetList = await tools.research_list_targets?.execute?.(
          {},
          { observe: noopObserve },
        );
        expect(targetList).toMatchObject({ targets: [], model_providers: ["openrouter"] });
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

it("rejects bad provider modules before touching storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensenpai-invalid-config-"));
  const configPath = join(directory, "invalid.mjs");
  await writeFile(configPath, "throw new Error('credential-must-not-escape')");
  try {
    await expect(
      createApplication(
        {},
        {
          transport: "stdio",
          configPath,
          databaseUrl: "file:/never-created/provider-config.db",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("uses one custom provider registry for discovery and execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensenpai-plugin-app-"));
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  const calls: string[] = [];
  const providers = {
    models: {
      custom: {
        availability() {
          calls.push("availability");
          return { available: true };
        },
        async execute() {
          calls.push("execute");
          return {
            answer: "custom provider answer",
            requested_model: "custom-model",
            model: "custom-model",
            serving_provider: "custom",
            response_id: "custom-response",
            finish_reason: "stop",
            sources: [],
            citations: [],
            extracted_urls: [],
            search_activity: {
              requested: "off" as const,
              observed: "not_observed" as const,
              engine: null,
            },
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              reasoning_tokens: null,
              cached_tokens: null,
              search_requests: 0,
              reported_cost_usd: 0,
              estimated_cost_usd: 0,
              raw: {},
            },
            raw_response: {},
            warnings: [],
          };
        },
      },
    },
    retrievals: {},
  };
  try {
    app = await createApplication(
      {
        INTERNAL_EXECUTION_TOKEN: "private-token-long-enough",
        OBSERVATION_DISPATCH_MODE: "external",
      },
      {
        databaseUrl: `file:${join(directory, "research.db")}`,
        transport: "stdio",
        listen: false,
        providers,
        targets: [
          { id: "custom", transport: "custom", model: "custom-model", search: { mode: "off" } },
        ],
      },
    );
    const listed = await app.service.listTargets();
    expect(listed.targets).toMatchObject([{ id: "custom", available: true }]);
    const { run } = await app.service.startRun({
      prompts: [{ id: "p", text: "Question?" }],
      targets: ["custom"],
      repetitions: 1,
      idempotency_key: "plugin-run",
    });
    const { observations } = await app.service.getResults({ run_id: run.id });
    const observation = observations[0];
    if (!observation) throw new Error("Missing queued observation");
    await app.runtime.executeObservation(observation.id);
    const result = await app.service.getResults({ run_id: run.id });
    expect(result.observations[0]?.result?.answer).toBe("custom provider answer");
    expect(calls).toContain("availability");
    expect(calls.filter((call) => call === "execute")).toHaveLength(1);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
