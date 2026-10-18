import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopObserve } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import type { Observation, RunEstimate, RunRecord } from "@opensenpai/core/contracts";
import {
  createOpenAICompatibleProvider,
  createProviderRegistry,
  exaProvider,
} from "@opensenpai/core/providers";
import { expect, it } from "vitest";
import { createApplication } from "../../src/application.js";

interface GatewayCall {
  path: string;
  authorization?: string;
  searchKey?: string;
  body: Record<string, unknown>;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function respond(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function gatewayHandler(
  request: IncomingMessage,
  response: ServerResponse,
  calls: GatewayCall[],
) {
  const body = await readBody(request);
  const path = request.url ?? "/";
  calls.push({
    path,
    authorization: request.headers.authorization,
    searchKey: request.headers["x-api-key"] as string | undefined,
    body,
  });
  if (path === "/search") {
    respond(response, {
      results: [
        {
          url: "https://fultonring.example/research",
          title: "Fulton Ring evidence",
          text: "Shared evidence marker: Fulton Ring develops technology for growing businesses.",
        },
      ],
      costDollars: { total: 0.003 },
    });
    return;
  }
  if (path !== "/v1/chat/completions") return respond(response, { error: "Unexpected route" }, 404);
  respond(response, {
    id: `local-${String(body.model)}`,
    object: "chat.completion",
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `Answer from ${String(body.model)}` },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  });
}

async function startGateway() {
  const calls: GatewayCall[] = [];
  const server = createServer((request, response) => {
    void gatewayHandler(request, response, calls).catch(() =>
      respond(response, { error: "Invalid fixture request" }, 500),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, calls, url: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

it("runs inline models with one shared controlled retrieval through authenticated HTTP MCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opensenpai-inline-mcp-"));
  const gateway = await startGateway();
  const catalogQueries: { query?: string; limit: number }[] = [];
  const model = createOpenAICompatibleProvider({
    name: "local-gateway",
    baseURL: `${gateway.url}/v1`,
    apiKeyEnv: "LOCAL_MODEL_KEY",
    pricing: { input_per_million: 1, output_per_million: 2, search_per_request: 0 },
    async listModels(query) {
      catalogQueries.push(query);
      return ["model-alpha", "model-beta"]
        .filter((id) => !query.query || id.includes(query.query))
        .slice(0, query.limit)
        .map((id) => ({ id }));
    },
  });
  const providers = createProviderRegistry({
    models: { gateway: model },
    retrievals: {
      exa: {
        ...exaProvider,
        retrieve: (input, context) =>
          exaProvider.retrieve(input, {
            ...context,
            fetch: (_url, init) => fetch(`${gateway.url}/search`, init),
          }),
      },
    },
  });
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let client: MCPClient | undefined;
  try {
    app = await createApplication(
      {
        MCP_AUTH_TOKEN: "local-inline-mcp-token",
        INTERNAL_EXECUTION_TOKEN: "local-inline-internal-token",
        OBSERVATION_DISPATCH_MODE: "external",
        LOCAL_MODEL_KEY: "fixture-model-key",
        EXA_API_KEY: "fixture-search-key",
      },
      { databaseUrl: `file:${join(directory, "research.db")}`, providers, targets: [], port: 0 },
    );
    const endpoint = `http://127.0.0.1:${app.port}/mcp`;
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    client = new MCPClient({
      id: "inline-local-mcp",
      servers: {
        research: {
          url: new URL(endpoint),
          allowedHosts: [`127.0.0.1:${app.port}`],
          requestInit: { headers: { Authorization: "Bearer local-inline-mcp-token" } },
        },
      },
    });
    const tools = await client.listTools();
    async function invoke<T>(name: string, input: Record<string, unknown>): Promise<T> {
      const tool = tools[`research_${name}`];
      if (!tool?.execute) throw new Error(`Missing MCP tool: ${name}`);
      return (await tool.execute(input, { observe: noopObserve })) as T;
    }
    const discovery = await invoke("list_targets", {
      provider: "gateway",
      model_query: "model-",
      limit: 2,
    });
    expect(discovery).toMatchObject({
      targets: [],
      model_providers: ["gateway"],
      retrieval_providers: ["exa"],
      models: [{ id: "model-alpha" }, { id: "model-beta" }],
    });
    expect(catalogQueries).toEqual([{ query: "model-", limit: 2 }]);
    const search = { mode: "controlled", engine: "exa", max_results: 1, max_characters: 1000 };
    const input = {
      prompts: [
        { id: "research", text: "What does Fulton Ring do?", queries: ["Fulton Ring technology"] },
      ],
      targets: ["model-alpha", "model-beta"].map((model, index) => ({
        id: `choice-${index}`,
        provider: "gateway",
        model,
        search,
      })),
      idempotency_key: "inline-http-mcp",
      max_estimated_cost_usd: 0.1,
    };
    const invalid = await invoke("estimate_run", {
      ...input,
      targets: [{ ...input.targets[0], pricing: { input_per_million: 0, output_per_million: 0 } }],
    });
    expect(invalid).toMatchObject({
      error: true,
      message: expect.stringContaining("additional properties"),
    });
    expect(gateway.calls).toHaveLength(0);
    const estimate = await invoke<RunEstimate>("estimate_run", input);
    expect(estimate.total_observations).toBe(2);
    expect(estimate.retrieval_estimated_cost_usd).toBe(0.02);
    expect(estimate.unpriced_targets).toEqual([]);
    expect(estimate.estimated_cost_usd).toBeGreaterThan(0.02);
    const started = await invoke<{ run: RunRecord; created: boolean }>("start_run", input);
    expect(started.created).toBe(true);
    expect(gateway.calls).toHaveLength(0);
    const pending = await invoke<{ observations: Observation[] }>("get_results", {
      run_id: started.run.id,
    });
    expect(pending.observations).toHaveLength(2);
    for (const observation of pending.observations)
      await app.runtime.executeObservation(observation.id);
    expect(
      await invoke<RunRecord>("get_run", { run_id: started.run.id, wait_ms: 0 }),
    ).toMatchObject({ status: "succeeded", counts: { succeeded: 2 } });
    const completed = await invoke<{ observations: Observation[] }>("get_results", {
      run_id: started.run.id,
    });
    expect(
      completed.observations.map((observation) => observation.result?.requested_model).sort(),
    ).toEqual(["model-alpha", "model-beta"]);
    expect(completed.observations.every((observation) => observation.status === "succeeded")).toBe(
      true,
    );
    const retrievals = gateway.calls.filter((call) => call.path === "/search");
    expect(retrievals).toHaveLength(1);
    expect(retrievals[0]).toMatchObject({
      searchKey: "fixture-search-key",
      body: { query: "Fulton Ring technology", numResults: 1 },
    });
    const generations = gateway.calls.filter((call) => call.path === "/v1/chat/completions");
    expect(generations.map((call) => call.body.model).sort()).toEqual([
      "model-alpha",
      "model-beta",
    ]);
    for (const generation of generations) {
      expect(generation.authorization).toBe("Bearer fixture-model-key");
      expect(JSON.stringify(generation.body.messages)).toContain("Shared evidence marker");
      expect(JSON.stringify(generation.body.messages)).toContain(
        "https://fultonring.example/research",
      );
    }
    expect((await invoke<{ created: boolean }>("start_run", input)).created).toBe(false);
    expect(gateway.calls).toHaveLength(3);
  } finally {
    await client?.disconnect();
    await app?.close();
    await closeServer(gateway.server);
    await rm(directory, { recursive: true, force: true });
  }
});
