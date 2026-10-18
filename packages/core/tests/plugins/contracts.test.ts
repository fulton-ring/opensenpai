import { expect, it } from "vitest";
import { targetSchema } from "../../src/contracts.js";

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
