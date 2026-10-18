import { expect, it } from "vitest";
import { type ProviderInput, targetSchema } from "../../src/contracts.js";
import { executeProvider } from "../../src/providers/index.js";

// Response metadata shape observed during the real customer-question experiment.
const raw = {
  id: "recorded-native",
  model: "anthropic/claude-haiku-5.5",
  provider: "Anthropic",
  object: "chat.completion",
  created: 1,
  choices: [
    { index: 0, message: { role: "assistant", content: "Retained answer" }, finish_reason: "stop" },
  ],
  usage: {
    prompt_tokens: 13826,
    completion_tokens: 1051,
    total_tokens: 14877,
    cost: 0.0119081,
    server_tool_use_details: { web_search_requests: 1 },
  },
  openrouter_metadata: {
    requested: "anthropic/claude-haiku-5.5",
    pipeline: [
      {
        type: "server_tools",
        name: "server-tools",
        data: { mode: "native", tools: ["openrouter:web_search"] },
      },
    ],
  },
};
function input(mode: "native" | "server" = "native"): ProviderInput {
  return {
    observation_id: "recorded",
    prompt: { id: "p", text: "Research" },
    locale: "en-US",
    signal: AbortSignal.timeout(5000),
    target: targetSchema.parse({
      id: "native",
      transport: "openrouter",
      model: raw.model,
      search: mode === "native" ? { mode } : { mode, engine: "exa" },
      provider_options: { provider: "anthropic" },
    }),
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(wire: unknown = raw, generation?: unknown): typeof fetch {
  return async (url) => {
    if (String(url).endsWith("/endpoints"))
      return json({
        data: {
          endpoints: [
            {
              tag: "anthropic",
              provider_name: "Anthropic",
              status: 0,
              native_tools: { "openrouter:web_search": { type: "web_search_20260209" } },
            },
          ],
        },
      });
    if (String(url).includes("/generation?"))
      return generation ? json({ data: generation }) : json({}, 404);
    return json(wire);
  };
}
const env = { OPENROUTER_API_KEY: "fixture" };

it("accepts native execution proved in the response when generation analytics are unavailable", async () => {
  const result = await executeProvider(input(), env, { fetch: fetcher() });
  expect(result.search_activity).toEqual({
    requested: "native",
    observed: "executed",
    engine: "native",
  });
  expect(result.serving_provider).toBe("Anthropic");
  expect(result.usage.reported_cost_usd).toBe(0.0119081);
  expect(result.raw_response).toMatchObject({ generation_metadata: [null] });
});

it("accepts an explicitly proved Exa server engine from response metadata", async () => {
  const wire = structuredClone(raw);
  Object.assign(wire.openrouter_metadata.pipeline[0]?.data ?? {}, {
    mode: "sdk",
    executed_engines: { "openrouter:web_search": ["exa"] },
  });
  const result = await executeProvider(input("server"), env, { fetch: fetcher(wire) });
  expect(result.search_activity.engine).toBe("exa");
});

it.each([
  {
    mode: "sdk",
    tools: ["openrouter:web_search"],
    executed_engines: { "openrouter:web_search": ["exa"] },
  },
  { mode: "native", tools: ["openrouter:web_fetch"] },
  {
    mode: "native",
    tools: ["openrouter:web_search"],
    executed_engines: { "openrouter:web_search": ["native", "exa"] },
  },
  { mode: "sdk", tools: ["openrouter:web_search"] },
])("rejects missing, mixed or substituted search evidence: %j", async (data) => {
  const wire = structuredClone(raw);
  Object.assign(wire.openrouter_metadata.pipeline[0] ?? {}, { data });
  await expect(executeProvider(input(), env, { fetch: fetcher(wire) })).rejects.toMatchObject({
    code: "search_proof_failed",
    result: { usage: { reported_cost_usd: 0.0119081 } },
  });
});

it.each([
  { model: raw.model, provider_name: "Anthropic", web_search_engine: "exa" },
  { model: "different/model", provider_name: "Anthropic", web_search_engine: "native" },
  { model: raw.model, provider_name: "Other", web_search_engine: "native" },
])(
  "rejects generation analytics that contradict positive response evidence",
  async (generation) => {
    await expect(
      executeProvider(input(), env, { fetch: fetcher(raw, generation) }),
    ).rejects.toMatchObject({ code: "search_proof_failed" });
  },
);

it.each(["model", "provider"])(
  "rejects a substituted response %s even when analytics match",
  async (field) => {
    const wire = { ...raw, [field]: "substituted" };
    await expect(
      executeProvider(input(), env, {
        fetch: fetcher(wire, {
          model: raw.model,
          provider_name: "Anthropic",
          web_search_engine: "native",
        }),
      }),
    ).rejects.toMatchObject({ code: "search_proof_failed" });
  },
);

it("requires actual executed search counters, not merely a native pipeline stage", async () => {
  const wire = {
    ...raw,
    usage: { ...raw.usage, server_tool_use_details: { web_search_requests: 0 } },
  };
  await expect(executeProvider(input(), env, { fetch: fetcher(wire) })).rejects.toMatchObject({
    code: "search_proof_failed",
  });
});
