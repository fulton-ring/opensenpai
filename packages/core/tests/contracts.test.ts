import { describe, expect, it } from "vitest";
import { runInputSchema, targetSchema } from "../src/contracts.js";

describe("research contracts", () => {
  it("bounds experiment expansion before a paid call", () => {
    expect(
      runInputSchema.safeParse({ prompts: [], targets: ["x"], idempotency_key: "test" }).success,
    ).toBe(false);
    expect(
      runInputSchema.safeParse({
        prompts: [{ id: "p", text: "hello" }],
        targets: ["x"],
        repetitions: 100,
        idempotency_key: "test",
      }).success,
    ).toBe(false);
  });

  it("supplies conservative defaults and rejects duplicate prompt ids", () => {
    const input = {
      prompts: [{ id: "p", text: "hello" }],
      targets: ["x"],
      idempotency_key: "test",
    };
    expect(runInputSchema.parse(input)).toMatchObject({ repetitions: 1, locale: "en-US" });
    expect(
      runInputSchema.safeParse({ ...input, prompts: [input.prompts[0], input.prompts[0]] }).success,
    ).toBe(false);
  });

  it("allows an explicit controlled Exa target without credentials", () => {
    const target = targetSchema.parse({
      id: "controlled",
      transport: "openrouter",
      model: "openai/gpt-6-luna",
      search: { mode: "controlled", engine: "exa" },
    });
    expect(target.search.mode).toBe("controlled");
    expect(target.max_output_tokens).toBe(512);
    expect(target.timeout_ms).toBe(120_000);
    expect(targetSchema.safeParse({ ...target, api_key: "secret" }).success).toBe(false);
  });
});

it("does not expose endpoint selection to research callers", () => {
  const input = {
    prompts: [{ id: "p", text: "Research" }],
    idempotency_key: "no-pin",
    targets: [
      {
        id: "gemini",
        provider: "openrouter",
        model: "google/gemini-3.8-flash",
        search: { mode: "native" },
      },
    ],
  };
  expect(runInputSchema.safeParse(input).success).toBe(true);
  expect(
    runInputSchema.safeParse({
      ...input,
      targets: [{ ...input.targets[0], serving_provider: "google-ai-studio" }],
    }).success,
  ).toBe(false);
});
