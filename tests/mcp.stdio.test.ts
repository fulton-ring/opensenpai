import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { noopObserve } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import { expect, it } from "vitest";

it("serves native stdio without bearer auth or stdout log contamination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensenpai-stdio-"));
  const client = new MCPClient({
    id: "stdio-protocol-check",
    servers: {
      research: {
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "--transport",
          "stdio",
          "--database-url",
          `file:${join(directory, "research.db")}`,
        ],
        env: { ROLE: "all", TRANSPORT: "stdio", OBSERVATION_DISPATCH_MODE: "native" },
      },
    },
  });
  try {
    const tools = await client.listTools();
    expect(Object.keys(tools)).toHaveLength(7);
    expect(await tools.research_list_runs?.execute?.({}, { observe: noopObserve })).toMatchObject({
      runs: [],
    });
  } finally {
    await client.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
