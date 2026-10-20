import { expect, it } from "vitest";
import { type ProviderInput, targetSchema } from "../../src/contracts.js";
import { createOpenRouterProvider, executeProvider } from "../../src/providers/index.js";

const context = { env: { OPENROUTER_API_KEY: "fixture-key" }, fetch };
const target = (search: unknown = { mode: "native" }) =>
  targetSchema.parse({
    id: "native-check",
    transport: "openrouter",
    model: "author/model",
    search,
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const capable = {
  tag: "native-provider",
  provider_name: "Provider",
  status: 0,
  native_tools: { "openrouter:web_search": { type: "provider_search" } },
  pricing: { prompt: "0.000001", completion: "0.000002", web_search: "0.01" },
};
const catalog = (endpoints: unknown[]) => json({ data: { id: "author/model", endpoints } });
const input = (value = target()): ProviderInput => ({
  observation_id: "o",
  target: value,
  prompt: { id: "p", text: "Research" },
  locale: "en-US",
  signal: AbortSignal.timeout(5000),
});
const raw = {
  id: "gen-1",
  model: "author/model",
  provider: "Provider",
  object: "chat.completion",
  created: 1,
  choices: [{ index: 0, message: { role: "assistant", content: "Answer" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cost: 0.01,
    server_tool_use_details: { web_search_requests: 1 },
  },
};

it("uses the ordinary key and resolves native-capable routes without a workspace policy", async () => {
  const adapter = createOpenRouterProvider();
  expect(adapter.availability(target(), context)).toEqual({ available: true });
  const requests: string[] = [];
  const resolved = await adapter.resolveTarget?.(target(), {
    ...context,
    fetch: async (url, init) => {
      requests.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
      return catalog([{ ...capable, tag: "unsupported", native_tools: {} }, capable]);
    },
  });
  expect(resolved?.provider_options?.provider).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("/endpoints");
});

it.each([undefined, null, false, true, {}, { type: "" }, { type: 1 }, "web_search"])(
  "rejects unknown native capability metadata before generation: %j",
  async (tool) => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      calls.push(String(url));
      return catalog([{ ...capable, native_tools: { "openrouter:web_search": tool } }]);
    };
    const adapter = createOpenRouterProvider({ nativeSearch: { apiKeyEnv: "OPENROUTER_API_KEY" } });
    await expect(
      adapter.resolveTarget?.(target(), { ...context, fetch: fetcher }),
    ).rejects.toMatchObject({ code: "target_unavailable" });
    await expect(adapter.execute(input(), { ...context, fetch: fetcher })).rejects.toMatchObject({
      code: "provider_not_dispatched",
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => url.endsWith("/endpoints"))).toBe(true);
  },
);

it("rechecks an operator pin and refuses capability loss before a paid call", async () => {
  let capableNow = true;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    calls.push(String(url));
    return catalog([
      { ...capable, native_tools: capableNow ? capable.native_tools : {} },
      { ...capable, tag: "alternate" },
    ]);
  };
  const adapter = createOpenRouterProvider();
  const resolved = await adapter.resolveTarget?.(
    { ...target(), provider_options: { provider: "native-provider" } },
    { ...context, fetch: fetcher },
  );
  if (!resolved) throw new Error("Missing resolved target");
  capableNow = false;
  await expect(
    adapter.execute(input(resolved), { ...context, fetch: fetcher }),
  ).rejects.toMatchObject({ code: "provider_not_dispatched" });
  expect(calls.every((url) => url.endsWith("/endpoints"))).toBe(true);
});

it.each([
  { engine: "native", search: { mode: "native" }, nativeTools: capable.native_tools },
  { engine: "exa", search: { mode: "server", engine: "exa" }, nativeTools: {} },
])(
  "routes $engine requests without imposing native capability on explicit Exa",
  async ({ engine, search, nativeTools }) => {
    let paid = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/endpoints"))
        return catalog([{ ...capable, native_tools: nativeTools }]);
      if (String(url).includes("/generation?"))
        return json({
          data: {
            model: "author/model",
            provider_name: "Provider",
            web_search_engine: engine,
            total_cost: 0.01,
          },
        });
      paid++;
      const body = JSON.parse(String(init?.body));
      expect(body.provider).toEqual({
        only: ["native-provider"],
        allow_fallbacks: true,
        require_parameters: true,
      });
      expect(body.tools[0].parameters.engine).toBe(engine);
      expect(body.messages.at(-1).content).toContain("Search the web before answering");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
      return json(raw);
    };
    const result = await executeProvider(input(target(search)), context.env, { fetch: fetcher });
    expect(paid).toBe(1);
    expect(result.search_activity.engine).toBe(engine);
  },
);

it.each([
  ["inactive endpoint", { ...capable, status: 1 }, 200, "author/model"],
  ["unavailable catalog", capable, 503, "author/model"],
  ["different model", capable, 200, "different/model"],
])("rejects %s without any paid generation", async (_name, endpoint, status, model) => {
  const calls: string[] = [];
  const adapter = createOpenRouterProvider();
  await expect(
    adapter.execute(input(), {
      ...context,
      fetch: async (url) => {
        calls.push(String(url));
        return json({ data: { id: model, endpoints: [endpoint] } }, status);
      },
    }),
  ).rejects.toMatchObject({ code: "provider_not_dispatched" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("/endpoints");
});

it.each([{ mode: "native" }, { mode: "server", engine: "exa" }, { mode: "off" }])(
  "does not opt $mode requests into a discounted or priority tier without an explicit pin",
  async (search) => {
    const adapter = createOpenRouterProvider();
    const endpoints = [
      { ...capable, tag: "provider/flex", service_tier: "flex" },
      { ...capable, tag: "provider/fast", service_tier: "priority" },
      { ...capable, service_tier: null },
    ];
    const fetcher: typeof fetch = async () => catalog(endpoints);
    const resolved = await adapter.resolveTarget?.(target(search), { ...context, fetch: fetcher });
    expect(resolved?.provider_options?.provider).toBeUndefined();
    const explicit = await adapter.resolveTarget?.(
      { ...target(search), provider_options: { provider: "provider/flex" } },
      { ...context, fetch: fetcher },
    );
    expect(explicit?.provider_options?.provider).toBe("provider/flex");
  },
);

it("does not silently choose Flex when no standard endpoint is available", async () => {
  await expect(
    createOpenRouterProvider().resolveTarget?.(target(), {
      ...context,
      fetch: async () => catalog([{ ...capable, tag: "provider/flex", service_tier: "flex" }]),
    }),
  ).rejects.toMatchObject({ code: "target_unavailable" });
});

it("exposes upstream throttling safely while retaining the failed response for accounting", async () => {
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/endpoints")
      ? catalog([capable])
      : json(
          {
            error: {
              code: 429,
              message: "PRIVATE ERROR",
              metadata: { limit_source: "upstream_provider_shared_pool" },
            },
          },
          429,
        );
  await expect(
    createOpenRouterProvider().execute(input(), { ...context, fetch: fetcher }),
  ).rejects.toMatchObject({
    code: "provider_http_429",
    message: "Compatible serving providers are rate-limited; retry later",
    result: { raw_response: { error: { code: 429 } } },
  });
});

it.each([{ limit_source: "account" }, undefined])(
  "does not advise another serving provider for non-upstream throttling (%o)",
  async (metadata) => {
    const fetcher: typeof fetch = async (url) =>
      String(url).endsWith("/endpoints")
        ? catalog([capable])
        : json({ error: { code: 429, message: "PRIVATE ERROR", metadata } }, 429);
    await expect(
      createOpenRouterProvider().execute(input(), { ...context, fetch: fetcher }),
    ).rejects.toMatchObject({
      code: "provider_http_429",
      message: "Request was rate-limited; retry later",
      result: { raw_response: { error: { code: 429 } } },
    });
  },
);

it("lets OpenRouter fail over between compatible endpoints without changing model or native search", async () => {
  const alternate = { ...capable, tag: "alternate", provider_name: "Alternate" };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/endpoints"))
      return catalog([
        capable,
        alternate,
        { ...capable, tag: "unsupported", native_tools: {} },
        { ...capable, tag: "native-provider/flex", service_tier: "flex" },
      ]);
    if (String(url).includes("/generation?")) return json({}, 404);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("author/model");
    expect(body.provider.only).toEqual(["native-provider", "alternate"]);
    expect(body.provider.allow_fallbacks).toBe(true);
    expect(body.provider.order).toBeUndefined();
    expect(body.provider.ignore).toContain("native-provider/flex");
    expect(body.tools[0].parameters.engine).toBe("native");
    return json({
      ...raw,
      provider: "Alternate",
      openrouter_metadata: {
        requested: "author/model",
        pipeline: [
          {
            type: "server_tools",
            name: "server-tools",
            data: { mode: "native", tools: ["openrouter:web_search"] },
          },
        ],
      },
    });
  };
  const adapter = createOpenRouterProvider();
  const resolved = await adapter.resolveTarget?.(target(), { ...context, fetch: fetcher });
  expect(resolved?.provider_options?.provider).toBeUndefined();
  const result = await adapter.execute(input(resolved), { ...context, fetch: fetcher });
  expect(result.serving_provider).toBe("Alternate");
  expect(result.search_activity.observed).toBe("executed");
  expect(calls.filter((url) => url.includes("/chat/completions"))).toHaveLength(1);
});

it("reserves the maximum compatible route prices and excludes later price increases before dispatch", async () => {
  const adapter = createOpenRouterProvider();
  const alternate = {
    ...capable,
    tag: "alternate",
    pricing: {
      prompt: "0.000003",
      completion: "0.000004",
      web_search: "0.02",
    },
  };
  const resolved = await adapter.resolveTarget?.(target(), {
    ...context,
    fetch: async () => catalog([capable, alternate]),
  });
  expect(resolved?.pricing).toEqual({
    input_per_million: 3,
    output_per_million: 4,
    search_per_request: 0.02,
  });
  const calls: string[] = [];
  await expect(
    adapter.execute(input(resolved), {
      ...context,
      fetch: async (url) => {
        calls.push(String(url));
        return catalog([{ ...alternate, pricing: { ...alternate.pricing, prompt: "0.000009" } }]);
      },
    }),
  ).rejects.toMatchObject({ code: "provider_not_dispatched" });
  expect(calls).toHaveLength(1);
});

it("uses a remaining compatible route when a default endpoint loses native capability", async () => {
  const adapter = createOpenRouterProvider();
  const resolved = await adapter.resolveTarget?.(target(), {
    ...context,
    fetch: async () => catalog([capable]),
  });
  let paid = 0;
  const result = await adapter.execute(input(resolved), {
    ...context,
    fetch: async (url, init) => {
      if (String(url).endsWith("/endpoints"))
        return catalog([
          { ...capable, native_tools: {} },
          { ...capable, tag: "alternate", provider_name: "Alternate" },
        ]);
      if (String(url).includes("/generation?")) return json({}, 404);
      paid++;
      const body = JSON.parse(String(init?.body));
      expect(body.provider.only).toEqual(["alternate"]);
      expect(body.provider.ignore).toContain("native-provider");
      return json({
        ...raw,
        provider: "Alternate",
        openrouter_metadata: {
          requested: "author/model",
          pipeline: [
            {
              type: "server_tools",
              name: "server-tools",
              data: { mode: "native", tools: ["openrouter:web_search"] },
            },
          ],
        },
      });
    },
  });
  expect(result.search_activity.observed).toBe("executed");
  expect(paid).toBe(1);
});
