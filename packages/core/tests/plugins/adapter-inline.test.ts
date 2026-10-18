import { expect, it } from "vitest";
import { targetSchema } from "../../src/contracts.js";
import {
  createOpenAICompatibleProvider,
  createOpenRouterProvider,
  createSdkProvider,
} from "../../src/providers/index.js";

const key = { env: { OPENROUTER_API_KEY: "test", NATIVE_KEY: "native" }, fetch: globalThis.fetch };
const router = createOpenRouterProvider({
  nativeSearch: { apiKeyEnv: "NATIVE_KEY", policy: "workspace-native-only" },
});
const target = (mode = "off") =>
  targetSchema.parse({
    id: "inline",
    transport: "openrouter",
    model: "author/model",
    search: { mode },
  });
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const endpoints = [
  {
    tag: "reseller",
    provider_name: "Reseller",
    native_tools: {},
    pricing: { prompt: "0.000001", completion: "0.000002", web_search: "0.02" },
  },
  {
    tag: "author",
    provider_name: "Author",
    native_tools: { "openrouter:web_search": {} },
    pricing: { prompt: "0.000003", completion: "0.000004", web_search: "0.01" },
  },
];
it("resolves an inline native model to its first capable endpoint and catalog pricing", async () => {
  const original = target("native");
  const resolved = await router.resolveTarget?.(original, {
    ...key,
    fetch: async () => response({ data: { endpoints } }),
  });
  expect(resolved).toMatchObject({
    id: original.id,
    model: original.model,
    search: original.search,
    provider_options: { provider: "author" },
    pricing: { input_per_million: 3, output_per_million: 4, search_per_request: 0.01 },
  });
  expect(original.provider_options).toBeUndefined();
});
it("respects explicit endpoint selection and never silently chooses another", async () => {
  const original = target("native");
  original.provider_options = { provider: "reseller" };
  await expect(
    router.resolveTarget?.(original, {
      ...key,
      fetch: async () => response({ data: { endpoints } }),
    }),
  ).rejects.toMatchObject({ code: "target_unavailable" });
});
it("uses a deterministic endpoint and pins plain and controlled models too", async () => {
  for (const search of [{ mode: "off" }, { mode: "controlled", engine: "exa" }]) {
    const original = targetSchema.parse({ ...target(), search });
    const resolved = await router.resolveTarget?.(original, {
      ...key,
      fetch: async () => response({ data: { endpoints } }),
    });
    expect(resolved?.provider_options?.provider).toBe("reseller");
    expect(resolved?.pricing?.search_per_request).toBe(0);
  }
});
it("prices explicit server search independently from native endpoint pricing", async () => {
  const original = targetSchema.parse({
    ...target(),
    search: { mode: "server", engine: "perplexity" },
  });
  const resolved = await router.resolveTarget?.(original, {
    ...key,
    fetch: async () => response({ data: { endpoints } }),
  });
  expect(resolved?.pricing?.search_per_request).toBe(0.005);
});
it("discards caller pricing and leaves unknown catalog prices unpriced", async () => {
  const original = target();
  original.pricing = { input_per_million: 0, output_per_million: 0, search_per_request: 0 };
  const resolved = await router.resolveTarget?.(original, {
    ...key,
    fetch: async () =>
      response({
        data: { endpoints: [{ ...endpoints[0], pricing: { prompt: "oops", completion: "-1" } }] },
      }),
  });
  expect(resolved?.pricing).toBeUndefined();
});
it("rejects bad endpoint catalog responses and missing keys without generation", async () => {
  await expect(
    router.resolveTarget?.(target(), { ...key, fetch: async () => response({}, 404) }),
  ).rejects.toMatchObject({ code: "target_unavailable" });
  let calls = 0;
  await expect(
    router.resolveTarget?.(target("native"), {
      env: { OPENROUTER_API_KEY: "general" },
      fetch: async () => {
        calls++;
        return response({});
      },
    }),
  ).rejects.toMatchObject({ code: "target_unavailable" });
  expect(calls).toBe(0);
});
it("discovers model ids directly with bounded case insensitive query filtering", async () => {
  const models = await router.listModels?.(
    { query: "CLAUDE", limit: 1 },
    {
      ...key,
      fetch: async () =>
        response({
          data: [
            { id: "anthropic/claude-one", name: "One" },
            { id: "other/model", name: "Claude special" },
            { id: "openai/test", name: "GPT" },
          ],
        }),
    },
  );
  expect(models).toEqual([{ id: "anthropic/claude-one", name: "One" }]);
});
it("SDK helpers pass discovery/resolution through and compatible helpers own prices", async () => {
  const resolveTarget = async (value: ReturnType<typeof target>) => ({
    ...value,
    pricing: { input_per_million: 2, output_per_million: 3, search_per_request: 0 },
  });
  const listModels = async () => [{ id: "custom" }];
  const sdk = createSdkProvider({
    resolveTarget,
    listModels,
    createModel: () => {
      throw new Error("unused");
    },
  });
  expect(sdk.resolveTarget).toBe(resolveTarget);
  expect(sdk.listModels).toBe(listModels);
  const compatible = createOpenAICompatibleProvider({
    name: "custom",
    baseURL: "https://gateway.test/v1",
    apiKeyEnv: "KEY",
    pricing: { input_per_million: 2, output_per_million: 3, search_per_request: 0 },
  });
  expect((await compatible.resolveTarget?.(target(), key))?.pricing?.input_per_million).toBe(2);
});
