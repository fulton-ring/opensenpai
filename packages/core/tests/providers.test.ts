import { expect, it } from "vitest";
import { type ProviderInput, targetSchema } from "../src/contracts.js";
import {
  createOpenRouterProvider,
  createProviderRegistry,
  executeProvider,
  retrieveExa,
} from "../src/providers/index.js";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function input(mode: "native" | "server" | "off" = "native"): ProviderInput {
  return {
    observation_id: "o",
    prompt: { id: "p", text: "Research" },
    locale: "en-US",
    signal: AbortSignal.timeout(5000),
    target: targetSchema.parse({
      id: "t",
      transport: "openrouter",
      model: "openai/test",
      search: mode === "server" ? { mode, engine: "perplexity" } : { mode },
      provider_options: { provider: "openai" },
    }),
  };
}
const raw = {
  id: "gen-1",
  model: "openai/test",
  provider: "OpenAI",
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
const providers = createProviderRegistry({
  models: {
    openrouter: createOpenRouterProvider({
      nativeSearch: { apiKeyEnv: "NATIVE_KEY" },
    }),
  },
});
const env = { OPENROUTER_API_KEY: "x", NATIVE_KEY: "native-secret" };
function mockFetch(engine = "native", provider = "OpenAI"): typeof fetch {
  return async (url) =>
    String(url).includes("/endpoints")
      ? response({
          data: {
            endpoints: [
              {
                tag: "openai",
                provider_name: "OpenAI",
                native_tools: { "openrouter:web_search": { type: "web_search" } },
              },
            ],
          },
        })
      : String(url).includes("/generation?")
        ? response({
            data: {
              provider_name: provider,
              model: "openai/test",
              web_search_engine: engine,
              total_cost: 0.01,
            },
          })
        : response(raw);
}
it("restricts compatible endpoints, allows failover and verifies actual native search evidence", async () => {
  let body: Record<string, unknown> = {};
  let key: unknown;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes("/chat/completions")) {
      body = JSON.parse(String(init?.body));
      key = new Headers(init?.headers).get("authorization");
    }
    return mockFetch()(url, init);
  };
  const result = await executeProvider(input(), env, { providers, fetch: fetcher });
  expect(body.provider).toEqual({
    only: ["openai"],
    allow_fallbacks: false,
    require_parameters: true,
  });
  expect(body.tools).toEqual([
    { type: "openrouter:web_search", parameters: { engine: "native", max_uses: 1 } },
  ]);
  expect(key).toBe("Bearer native-secret");
  expect(result.search_activity).toEqual({
    requested: "native",
    observed: "executed",
    engine: "native",
  });
  expect(result.usage.reported_cost_usd).toBe(0.01);
});
it.each([
  ["exa", "OpenAI"],
  ["native", "Azure"],
  [null, "OpenAI"],
])(
  "fails closed on substituted or unverifiable engine/provider: %s %s",
  async (engine, provider) => {
    await expect(
      executeProvider(input(), env, {
        providers,
        fetch: mockFetch(engine as string, provider as string),
      }),
    ).rejects.toMatchObject({
      code: "search_proof_failed",
      result: { usage: { reported_cost_usd: 0.01 } },
    });
  },
);
it("rejects unavailable native endpoints before paid dispatch", async () => {
  let calls = 0;
  await expect(
    executeProvider(input(), env, {
      providers,
      fetch: async () => {
        calls++;
        return response({ data: { endpoints: [] } });
      },
    }),
  ).rejects.toMatchObject({ code: "provider_not_dispatched" });
  expect(calls).toBe(1);
});
it("rejects a missing OpenRouter key before requesting metadata", async () => {
  await expect(
    executeProvider(
      input(),
      {},
      {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      },
    ),
  ).rejects.toMatchObject({ code: "provider_not_dispatched" });
});
it("supports an explicit Perplexity server engine without demanding a native workspace", async () => {
  const result = await executeProvider(input("server"), env, { fetch: mockFetch("perplexity") });
  expect(result.search_activity.engine).toBe("perplexity");
});
it("never retries a paid generation after HTTP failure", async () => {
  let calls = 0;
  await expect(
    executeProvider(input("off"), env, {
      fetch: async (url, init) => {
        if (String(url).includes("/endpoints")) return mockFetch()(url, init);
        calls++;
        return response({ error: { message: "private" } }, 500);
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
it("retrieves Exa once per query and preserves ordered deduplicated sources", async () => {
  let calls = 0;
  const bundle = await retrieveExa(
    {
      id: "b",
      queries: ["a", "b"],
      max_results: 2,
      max_characters: 100,
      signal: AbortSignal.timeout(5000),
    },
    { EXA_API_KEY: "x" },
    {
      fetch: async () => {
        calls++;
        return response({
          results: [{ url: "https://a.test", text: "x".repeat(200) }],
          costDollars: { total: 0.004 },
        });
      },
    },
  );
  expect(calls).toBe(2);
  expect(bundle.sources).toHaveLength(1);
  expect(bundle.context.length).toBeLessThanOrEqual(100);
  expect(bundle.reported_cost_usd).toBe(0.008);
});
it("rejects a native answer with no executed search and preserves its charge", async () => {
  const fetcher: typeof fetch = async (url, init) =>
    String(url).includes("/chat/completions")
      ? response({
          ...raw,
          usage: { ...raw.usage, server_tool_use_details: { web_search_requests: 0 } },
        })
      : mockFetch()(url, init);
  await expect(executeProvider(input(), env, { providers, fetch: fetcher })).rejects.toMatchObject({
    code: "search_proof_failed",
    result: { usage: { search_requests: 0, reported_cost_usd: 0.01 } },
  });
});
it("handles intrinsic Sonar without sending an unsupported server tool", async () => {
  const request = input();
  request.target.model = "perplexity/sonar";
  request.target.provider_options = { provider: "perplexity" };
  let body: Record<string, unknown> = {};
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes("/endpoints"))
      return response({
        data: { endpoints: [{ tag: "perplexity", provider_name: "Perplexity", native_tools: {} }] },
      });
    if (String(url).includes("/generation?"))
      return response({
        data: {
          provider_name: "Perplexity",
          model: "perplexity/sonar",
          web_search_engine: "native",
          total_cost: 0.01,
        },
      });
    body = JSON.parse(String(init?.body));
    return response({ ...raw, model: "perplexity/sonar", provider: "Perplexity" });
  };
  const result = await executeProvider(request, env, { providers, fetch: fetcher });
  expect(body.tools).toBeUndefined();
  expect(body.provider).toMatchObject({ only: ["perplexity"], allow_fallbacks: false });
  expect(result.search_activity.engine).toBe("native");
});
it("does not treat citations as proof that the requested search ran", async () => {
  const fetcher: typeof fetch = async (url, init) =>
    String(url).includes("/chat/completions")
      ? response({
          ...raw,
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.02 },
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Answer",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://source.test",
                      title: "Source",
                      start_index: 0,
                      end_index: 6,
                    },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
        })
      : mockFetch()(url, init);
  await expect(executeProvider(input(), env, { providers, fetch: fetcher })).rejects.toMatchObject({
    code: "search_proof_failed",
    result: { citations: [{ url: "https://source.test" }] },
  });
});
