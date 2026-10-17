import { expect, it, vi } from "vitest";
import { type ProviderInput, targetSchema } from "../src/contracts.js";

// Keep the native Google wire/parser implementation; bypass only OAuth in this no-network test.
vi.mock("@ai-sdk/google-vertex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/google-vertex")>();
  return {
    ...actual,
    createVertex: (options: Parameters<typeof actual.createVertex>[0]) =>
      actual.createVertex({ ...options, apiKey: "mock-key" }),
  };
});

import { executeProvider } from "../src/providers/index.js";

const credentials = Buffer.from(
  JSON.stringify({
    project_id: "p",
    client_email: "a@p.iam.gserviceaccount.com",
    private_key: "mock",
  }),
).toString("base64");
function input(): ProviderInput {
  return {
    observation_id: "o",
    prompt: { id: "p", text: "q" },
    locale: "en-US",
    signal: new AbortController().signal,
    target: targetSchema.parse({
      id: "v",
      transport: "vertex",
      model: "gemini-3.8-flash",
      search: { mode: "native" },
      pricing: { input_per_million: 1, output_per_million: 2, search_per_request: 0.01 },
    }),
  };
}
function raw(text: string, finishReason = "STOP") {
  return {
    modelVersion: "gemini-3.8-flash",
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason,
        groundingMetadata: {
          webSearchQueries: [text],
          groundingChunks: [{ web: { uri: `https://${text}.test`, title: text } }],
          groundingSupports: [
            { segment: { text, startIndex: 0, endIndex: text.length }, groundingChunkIndices: [0] },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
}
it("preserves every Google continuation response and combined evidence with SDK aggregate usage", async () => {
  const first = raw("first", "CONTINUATION");
  Object.assign(first.candidates[0] ?? {}, { continuationToken: "continue" });
  const last = raw("last");
  let calls = 0;
  const result = await executeProvider(
    input(),
    { GOOGLE_APPLICATION_CREDENTIALS: credentials },
    {
      fetch: async () =>
        new Response(JSON.stringify(calls++ === 0 ? first : last), {
          headers: { "content-type": "application/json" },
        }),
    },
  );
  expect(calls).toBe(2);
  expect(result.raw_response).toEqual({ responses: [first, last] });
  expect(result.usage.input_tokens).toBe(20);
  expect(result.usage.output_tokens).toBe(10);
  expect(result.sources.map((s) => s.url)).toEqual(["https://first.test", "https://last.test"]);
  expect(result.citations).toHaveLength(2);
  expect(result.usage.search_requests).toBe(2);
});
it("includes Google thoughts and tool prompt tokens exactly once", async () => {
  const body = raw("answer");
  Object.assign(body.usageMetadata, {
    thoughtsTokenCount: 7,
    toolUsePromptTokenCount: 3,
    totalTokenCount: 25,
  });
  const result = await executeProvider(
    input(),
    { GOOGLE_APPLICATION_CREDENTIALS: credentials },
    {
      fetch: async () =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    },
  );
  expect(result.usage.input_tokens).toBe(13);
  expect(result.usage.output_tokens).toBe(12);
  expect(result.usage.reasoning_tokens).toBe(7);
  expect(result.usage.estimated_cost_usd).toBeCloseTo(0.010037);
});
