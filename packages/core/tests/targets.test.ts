import { expect, it } from "vitest";
import { runInputSchema, targetSchema } from "../src/contracts.js";
import { estimateRun, loadTargets, targetAvailability } from "../src/targets.js";

it("keeps presets optional and resolves availability through registered providers", () => {
  expect(loadTargets({})).toEqual([]);
  expect(loadTargets({ TARGETS_JSON: "[]" })).toEqual([]);
  const target = targetSchema.parse({
    id: "model",
    transport: "openrouter",
    model: "any/model",
    search: { mode: "off" },
  });
  expect(targetAvailability(target, {}).available).toBe(false);
  expect(targetAvailability(target, { OPENROUTER_API_KEY: "test" }).available).toBe(true);
  expect(targetAvailability({ ...target, transport: "constructor" }, {}).available).toBe(false);
});
it("validates configured targets and rejects duplicate IDs", () => {
  const target = { id: "a", transport: "custom-gateway", model: "m", search: { mode: "off" } };
  expect(() => loadTargets({}, [target, target])).toThrow();
});
it("counts shared retrieval once per prompt, repetition and retrieval options", () => {
  const a = targetSchema.parse({
    id: "a",
    transport: "openai",
    model: "m",
    search: { mode: "controlled", engine: "exa", max_results: 3, max_characters: 100 },
    pricing: { input_per_million: 1, output_per_million: 2 },
  });
  const b = { ...a, id: "b" };
  const input = runInputSchema.parse({
    prompts: [{ id: "p", text: "question", queries: ["q", "r"] }],
    targets: ["a", "b"],
    repetitions: 2,
    idempotency_key: "k",
  });
  const estimate = estimateRun(input, [a, b]);
  expect(estimate.total_observations).toBe(4);
  expect(estimate.retrieval_estimated_cost_usd).toBe(0.08);
  expect(estimate.estimated_cost_usd).toBeGreaterThan(0.08);
  const unpriced = estimateRun(input, [{ ...a, pricing: undefined }, b]);
  expect(unpriced.estimated_cost_usd).toBeNull();
  expect(unpriced.unpriced_targets).toEqual(["a"]);
});
it("rejects implicit OpenRouter online search in controlled targets", () => {
  const target = targetSchema.parse({
    id: "x",
    transport: "openrouter",
    model: "openai/gpt-6-luna:online",
    search: { mode: "controlled", engine: "exa" },
  });
  expect(targetAvailability(target, { OPENROUTER_API_KEY: "x", EXA_API_KEY: "x" }).available).toBe(
    false,
  );
});
it("preserves the caller's explicitly configured reasoning effort", () => {
  const targets = [
    {
      id: "custom",
      transport: "openrouter",
      model: "any/model",
      search: { mode: "off" },
      reasoning_effort: "low",
    },
  ];
  expect(loadTargets({ TARGETS_JSON: JSON.stringify(targets) })[0]?.reasoning_effort).toBe("low");
  expect(() =>
    loadTargets({
      TARGETS_JSON: JSON.stringify([{ ...targets[0], reasoning_effort: "unbounded" }]),
    }),
  ).toThrow();
});
