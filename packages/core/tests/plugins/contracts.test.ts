import { expect, it } from "vitest";
import { runInputSchema, targetSchema } from "../../src/contracts.js";

it("accepts custom model and retrieval adapters with JSON options", () => {
  expect(
    targetSchema.parse({
      id: "custom",
      transport: "my-gateway",
      model: "model-one",
      search: { mode: "controlled", engine: "my-search", options: { locale: "en" } },
      provider_options: { region: "local" },
    }),
  ).toMatchObject({ transport: "my-gateway", search: { engine: "my-search" } });
});
it("accepts inline model/search selections but refuses caller-supplied pricing and provider settings", () => {
  const selection = {
    id: "glm-exa",
    provider: "openrouter",
    model: "example/glm",
    search: { mode: "controlled", engine: "exa" },
  };
  const input = {
    prompts: [{ id: "p", text: "research" }],
    targets: [selection],
    idempotency_key: "inline",
  };
  expect(runInputSchema.parse(input).targets[0]).toMatchObject(selection);
  expect(() =>
    runInputSchema.parse({
      ...input,
      targets: [{ ...selection, pricing: { input_per_million: 0 } }],
    }),
  ).toThrow();
  expect(() =>
    runInputSchema.parse({
      ...input,
      targets: [{ ...selection, provider_options: { api_key_env: "OTHER_SECRET" } }],
    }),
  ).toThrow();
});
it("distinguishes explicit server search from provider-native search", () => {
  expect(
    targetSchema.parse({
      id: "perplexity-search",
      transport: "openrouter",
      model: "openai/gpt-6-luna",
      search: { mode: "server", engine: "perplexity" },
    }).search,
  ).toEqual({ mode: "server", engine: "perplexity", max_uses: 1 });
});
