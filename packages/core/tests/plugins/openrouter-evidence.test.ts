import { expect, it, vi } from "vitest";
import { type ProviderInput, targetSchema } from "../../src/contracts.js";
import { executeProvider } from "../../src/providers/index.js";
import { normalize } from "../../src/providers/normalize.js";
import { createOpenRouterProvider } from "../../src/providers/openrouter.js";
import * as sdk from "../../src/providers/sdk.js";

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

function sonarWire() {
  return {
    ...raw,
    model: "perplexity/sonar",
    provider: "Perplexity",
    usage: { prompt_tokens: 34, completion_tokens: 991, total_tokens: 1025, cost: 0.00603 },
    openrouter_metadata: { requested: "perplexity/sonar", strategy: "direct", attempt: 1 },
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Grounded answer [1]",
          annotations: [
            {
              type: "url_citation",
              url_citation: { url: "https://example.com/evidence", title: "Evidence" },
            },
          ],
        },
        finish_reason: "stop",
      },
    ],
  };
}

async function sonarResult(wire: unknown) {
  const request = input();
  request.target = targetSchema.parse({
    id: "sonar",
    transport: "openrouter",
    model: "perplexity/sonar",
    search: { mode: "native" },
    provider_options: { provider: "perplexity" },
  });
  return executeProvider(request, env, {
    fetch: async (url, init) => {
      if (String(url).endsWith("/endpoints"))
        return json({
          data: { endpoints: [{ tag: "perplexity", provider_name: "Perplexity", status: 0 }] },
        });
      if (String(url).includes("/generation?")) return json({}, 404);
      const body = JSON.parse(String(init?.body));
      expect(body.provider.allow_fallbacks).toBe(false);
      expect(body.tools).toBeUndefined();
      return json(wire);
    },
  });
}

it("recognizes first-party Sonar grounding without inventing unavailable search counters", async () => {
  const result = await sonarResult(sonarWire());
  expect(result.search_activity).toEqual({
    requested: "native",
    observed: "executed",
    engine: "native",
  });
  expect(result.usage.search_requests).toBeNull();
  expect(result.citations).toMatchObject([{ url: "https://example.com/evidence" }]);
  expect(result.usage.reported_cost_usd).toBe(0.00603);
});

it.each([
  { provider: "Other" },
  { model: "different/model" },
  { openrouter_metadata: { requested: "perplexity/sonar", strategy: "fallback", attempt: 2 } },
  {
    choices: [
      { index: 0, message: { role: "assistant", content: "No grounding" }, finish_reason: "stop" },
    ],
  },
  { usage: { ...sonarWire().usage, server_tool_use_details: { web_search_requests: 0 } } },
])("rejects incomplete or contradictory intrinsic Sonar proof: %j", async (change) => {
  await expect(sonarResult({ ...sonarWire(), ...change })).rejects.toMatchObject({
    code: "search_proof_failed",
  });
});

it.each(["normal", "failed", "wrapped", "multiple"])(
  "reconciles %s evidence using metadata GETs only",
  async (shape) => {
    const request = input();
    request.target.search = { mode: "off" };
    const result = normalize(
      request,
      { ...raw, ...(shape === "failed" ? { error: { message: "failed" } } : {}) },
      "",
      null,
    );
    if (shape === "wrapped")
      result.raw_response = { generation: { responses: [raw] }, generation_metadata: [null] };
    if (shape === "multiple")
      result.raw_response = { responses: [raw, raw, { ...raw, id: "second" }] };
    const calls: string[] = [];
    const usage = await createOpenRouterProvider().reconcileUsage?.(request.target, result, {
      env,
      fetch: async (url, init) => {
        calls.push(String(url));
        expect(init?.method ?? "GET").toBe("GET");
        expect(String(url)).toContain("/generation?id=");
        return json({
          data: {
            id: new URL(String(url)).searchParams.get("id"),
            model: raw.model,
            provider_name: "Anthropic",
            total_cost: 0.03,
          },
        });
      },
    });
    expect(usage?.reported_cost_usd).toBe(shape === "multiple" ? 0.06 : 0.03);
    expect(calls).toHaveLength(shape === "multiple" ? 2 : 1);
  },
);

it.each([
  "missing-id",
  "missing-metadata",
  "negative",
  "wrong-model",
  "wrong-provider",
  "partial",
  "wrong-id",
  "missing-metadata-id",
  "infinite",
  "incomplete-two",
])("leaves %s billing evidence unresolved", async (shape) => {
  const request = input();
  const result = normalize(request, raw, "", null);
  if (shape === "missing-id") {
    result.response_id = null;
    result.raw_response = {};
  }
  if (shape === "partial") result.raw_response = { responses: [raw, { usage: {} }] };
  if (shape === "incomplete-two")
    result.raw_response = { responses: [raw, { ...raw, id: "second" }] };
  const usage = await createOpenRouterProvider().reconcileUsage?.(request.target, result, {
    env,
    fetch: async (url) => {
      const data: Record<string, unknown> = {
        id: new URL(String(url)).searchParams.get("id"),
        model: raw.model,
        provider_name: "Anthropic",
        total_cost: 0.03,
      };
      if (shape === "missing-metadata-id") delete data.id;
      if (shape === "wrong-id") data.id = "wrong";
      if (shape === "wrong-model") data.model = "wrong";
      if (shape === "wrong-provider") data.provider_name = "Other";
      data.total_cost =
        ({ negative: -1, infinite: Infinity } as Record<string, number>)[shape] ?? 0.03;
      if (shape === "missing-metadata") delete data.total_cost;
      if (shape === "incomplete-two" && String(url).includes("second")) delete data.total_cost;
      return json({ data });
    },
  });
  expect(usage).toBeNull();
});

it.each([-1, Number.NaN])(
  "preserves known response cost when metadata cost is invalid: %s",
  async (total_cost) => {
    const result = await executeProvider(input(), env, {
      fetch: fetcher(raw, { id: raw.id, total_cost }),
    });
    expect(result.usage.reported_cost_usd).toBe(raw.usage.cost);
  },
);

it("counts repeated generation IDs once while retaining exact response evidence", () => {
  const result = normalize(input(), raw, "", null, { responses: [raw, raw] });
  expect(result.usage.reported_cost_usd).toBe(raw.usage.cost);
  expect(result.raw_response).toEqual({ responses: [raw, raw] });
});

it("retains partial known charges in raw usage without treating missing charges as zero", () => {
  const result = normalize(input(), raw, "", null, { responses: [raw, { id: "unknown" }] });
  expect(result.usage.reported_cost_usd).toBeNull();
  expect(result.usage.raw).toMatchObject({ responses: [{ cost: raw.usage.cost }, {}] });
});

it.each(["wrong-id", "wrong-model", "wrong-provider"])(
  "keeps known charges when immediate metadata has %s",
  async (shape) => {
    const operation = executeProvider(input(), env, {
      fetch: fetcher(raw, {
        id: shape === "wrong-id" ? "other" : raw.id,
        model: shape === "wrong-model" ? "other" : raw.model,
        provider_name: shape === "wrong-provider" ? "Other" : raw.provider,
        total_cost: 9,
      }),
    });
    const result = await operation.catch((error) => error.result);
    expect(result.usage.reported_cost_usd).toBe(raw.usage.cost);
  },
);

it("deduplicates metadata reads and charges during immediate multiresponse verification", async () => {
  const spy = vi.spyOn(sdk, "createSdkProvider").mockImplementationOnce((options) => ({
    availability: () => ({ available: true }),
    execute: async (request, context) => {
      if (!options.verify) throw new Error("Verifier required");
      return options.verify(
        normalize(request, raw, "Answer", "stop", { responses: [raw, raw] }),
        request,
        context,
      );
    },
  }));
  let metadataReads = 0;
  const transport = fetcher(raw, {
    id: raw.id,
    model: raw.model,
    provider_name: raw.provider,
    total_cost: 0.03,
  });
  try {
    const result = await executeProvider(input(), env, {
      fetch: async (url, init) => {
        if (String(url).includes("/generation?")) metadataReads++;
        return transport(url, init);
      },
    });
    expect(result.usage.reported_cost_usd).toBe(0.03);
    expect(metadataReads).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

it.each(["", "   "])("does not deduplicate unidentified responses with ID %j", (id) => {
  const responses = [
    { id, usage: { cost: 0.02 } },
    { id, usage: { cost: 0.03 } },
  ];
  const result = normalize(input(), responses[1] ?? {}, "", null, { responses });
  expect(result.usage.reported_cost_usd).toBe(0.05);
});
