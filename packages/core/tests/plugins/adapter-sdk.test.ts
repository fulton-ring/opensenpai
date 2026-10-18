import { expect, it } from "vitest";
import { type ProviderInput, targetSchema } from "../../src/contracts.js";
import {
  createOpenAICompatibleProvider,
  createProviderRegistry,
  createSdkProvider,
  executeProvider,
  retrieveSearch,
} from "../../src/providers/index.js";

function input(): ProviderInput {
  return {
    observation_id: "o",
    prompt: { id: "p", text: "Question" },
    locale: "en-US",
    signal: AbortSignal.timeout(5000),
    target: targetSchema.parse({
      id: "gateway",
      transport: "competitor",
      model: "custom-model",
      search: { mode: "off" },
    }),
  };
}
function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
it("adds an OpenAI-compatible competitor through registry configuration alone", async () => {
  let requestURL = "";
  let authorization = "";
  const providers = createProviderRegistry({
    models: {
      competitor: createOpenAICompatibleProvider({
        name: "competitor",
        baseURL: "https://gateway.test/v1",
        apiKeyEnv: "GATEWAY_KEY",
      }),
    },
  });
  const result = await executeProvider(
    input(),
    { GATEWAY_KEY: "private" },
    {
      providers,
      fetch: async (url, init) => {
        requestURL = String(url);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return response({
          id: "custom",
          model: "custom-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Gateway answer" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        });
      },
    },
  );
  expect(requestURL).toBe("https://gateway.test/v1/chat/completions");
  expect(authorization).toBe("Bearer private");
  expect(result.answer).toBe("Gateway answer");
  expect(result.usage.input_tokens).toBe(9);
  expect(result.usage.reported_cost_usd).toBeNull();
  expect(result.search_activity.observed).toBe("not_observed");
});
it("normalizes a Mastra-compatible custom SDK model using standard SDK usage and sources", async () => {
  const provider = createSdkProvider({
    createModel: () => ({
      model: {
        specificationVersion: "v4",
        provider: "custom",
        modelId: "custom-model",
        supportedUrls: {},
        doGenerate: async () => ({
          content: [
            { type: "text", text: "SDK answer" },
            {
              type: "source",
              sourceType: "url",
              id: "s",
              url: "https://source.test",
              title: "Source",
            },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 3, text: 3, reasoning: 0 },
          },
          warnings: [],
          response: { id: "sdk-1", modelId: "custom-model" },
        }),
        doStream: async () => {
          throw new Error("unused");
        },
      },
    }),
  });
  const result = await executeProvider(
    input(),
    {},
    { providers: createProviderRegistry({ models: { competitor: provider } }) },
  );
  expect(result.response_id).toBe("sdk-1");
  expect(result.answer).toBe("SDK answer");
  expect(result.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
  expect(result.sources).toMatchObject([{ url: "https://source.test" }]);
});
it("requires explicit search proof for generic SDK adapters and avoids dispatch", async () => {
  const request = input();
  request.target.search = { mode: "native", max_uses: 1 };
  const providers = createProviderRegistry({
    models: {
      competitor: createOpenAICompatibleProvider({
        name: "competitor",
        baseURL: "https://gateway.test/v1",
        apiKeyEnv: "KEY",
      }),
    },
  });
  await expect(
    executeProvider(
      request,
      { KEY: "x" },
      {
        providers,
        fetch: async () => {
          throw new Error("must not fetch");
        },
      },
    ),
  ).rejects.toMatchObject({ code: "provider_not_dispatched" });
});
it("allows replacing controlled retrieval without hardcoded Exa behavior", async () => {
  const providers = createProviderRegistry({
    retrievals: {
      custom: {
        availability: () => ({ available: true }),
        estimate: () => 0.001,
        retrieve: async (value) => ({
          id: value.id,
          queries: value.queries,
          context: "custom",
          sources: [],
          raw_response: { custom: true },
          estimated_cost_usd: 0.001,
          reported_cost_usd: 0.001,
          created_at: new Date().toISOString(),
        }),
      },
    },
  });
  const bundle = await retrieveSearch(
    {
      id: "r",
      engine: "custom",
      queries: ["q"],
      max_results: 1,
      max_characters: 100,
      signal: AbortSignal.timeout(5000),
    },
    {},
    { providers },
  );
  expect(bundle.context).toBe("custom");
});
it("retains terminal provider errors and counters without copying private messages", async () => {
  const providers = createProviderRegistry({
    models: {
      competitor: createOpenAICompatibleProvider({
        name: "competitor",
        baseURL: "https://gateway.test/v1",
        apiKeyEnv: "KEY",
      }),
    },
  });
  await expect(
    executeProvider(
      input(),
      { KEY: "x" },
      {
        providers,
        fetch: async () =>
          response({
            id: "failed",
            error: { message: "PRIVATE VENDOR MESSAGE" },
            usage: { prompt_tokens: 7, completion_tokens: 2, cost: 0.02 },
          }),
      },
    ),
  ).rejects.toMatchObject({
    code: "provider_failed",
    message: "Provider reported generation failure",
    result: { usage: { input_tokens: 7, output_tokens: 2, reported_cost_usd: 0.02 } },
  });
});
