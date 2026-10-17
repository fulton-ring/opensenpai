import { describe, expect, it } from "vitest";
import { type ProviderInput, targetSchema } from "../src/contracts.js";
import { executeProvider, retrieveExa } from "../src/providers/index.js";

const input = (
  transport = "openai",
  search: unknown = { mode: "native", max_uses: 1 },
): ProviderInput => ({
  observation_id: "o",
  prompt: { id: "p", text: "Question" },
  locale: "en-US",
  signal: new AbortController().signal,
  target: targetSchema.parse({
    id: "t",
    transport,
    model: transport === "openai" ? "gpt-6-luna" : "test-model",
    search,
  }),
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const openai = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "gpt-6-luna",
  status: "completed",
  output: [
    {
      id: "w",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "q",
        sources: [{ type: "url", url: "https://source.test" }],
      },
    },
    {
      id: "m",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Answer https://text.test",
          annotations: [
            {
              type: "url_citation",
              url: "https://cited.test",
              title: "Cited",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 12, output_tokens: 8, output_tokens_details: { reasoning_tokens: 2 } },
};
describe("provider wire adapters", () => {
  it("uses Responses native search, preserves raw evidence and separates text URLs", async () => {
    let body: Record<string, unknown> = {};
    let url = "";
    const result = await executeProvider(
      input(),
      { OPENAI_API_KEY: "secret" },
      {
        fetch: async (u, init) => {
          url = String(u);
          body = JSON.parse(String(init?.body));
          return response(openai);
        },
      },
    );
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(body.model).toBe("gpt-6-luna");
    expect(body.tools).toEqual([expect.objectContaining({ type: "web_search" })]);
    expect(result.answer).toBe("Answer https://text.test");
    expect(result.raw_response).toEqual(openai);
    expect(result.sources.map((s) => s.url)).toEqual(["https://source.test"]);
    expect(result.citations.map((c) => c.url)).toEqual(["https://cited.test"]);
    expect(result.extracted_urls).toEqual(["https://text.test"]);
    expect(result.search_activity.observed).toBe("executed");
    expect(result.usage.input_tokens).toBe(12);
  });
  it("does not retry an HTTP failure", async () => {
    let calls = 0;
    await expect(
      executeProvider(
        input(),
        { OPENAI_API_KEY: "secret" },
        {
          fetch: async () => {
            calls++;
            return response({ error: { message: "no" } }, 500);
          },
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("uses Agent API for Perplexity and leaves missing usage null", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const result = await executeProvider(
      input("perplexity"),
      { PERPLEXITY_API_KEY: "secret" },
      {
        fetch: async (u, i) => {
          url = String(u);
          body = JSON.parse(String(i?.body));
          return response({
            id: "r",
            model: "test-model",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Answer", annotations: [] }],
              },
            ],
          });
        },
      },
    );
    expect(url).toBe("https://api.perplexity.ai/v1/agent");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(result.usage.input_tokens).toBeNull();
    expect(result.search_activity.observed).toBe("unknown");
  });
  it("retrieves once per query, deduplicates in query order and bounds exact injected context", async () => {
    let calls = 0;
    const bundle = await retrieveExa(
      {
        id: "b",
        queries: ["one", "two"],
        max_results: 2,
        max_characters: 120,
        signal: new AbortController().signal,
      },
      { EXA_API_KEY: "secret" },
      {
        fetch: async () => {
          calls++;
          return response({
            results: [
              { url: "https://a.test", title: "A", text: "x".repeat(300) },
              { url: "https://b.test", title: "B", text: "y" },
            ],
            costDollars: { total: 0.004 },
          });
        },
      },
    );
    expect(calls).toBe(2);
    expect(bundle.sources).toHaveLength(2);
    expect(bundle.context.length).toBeLessThanOrEqual(120);
    expect(bundle.reported_cost_usd).toBe(0.008);
    const controlled = input("openai", {
      mode: "controlled",
      engine: "exa",
      max_results: 2,
      max_characters: 120,
    });
    controlled.retrieval = bundle;
    let body: Record<string, unknown> = {};
    await executeProvider(
      controlled,
      { OPENAI_API_KEY: "secret" },
      {
        fetch: async (_u, i) => {
          body = JSON.parse(String(i?.body));
          return response({ ...openai, output: openai.output.slice(1) });
        },
      },
    );
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body.input)).toContain(JSON.stringify(bundle.context).slice(1, -1));
  });
  it("rejects controlled generation without a retrieval and validates retrieval limits", async () => {
    await expect(
      executeProvider(input("openai", { mode: "controlled", engine: "exa" }), {
        OPENAI_API_KEY: "secret",
      }),
    ).rejects.toThrow(/retrieval/i);
    await expect(
      retrieveExa(
        {
          id: "b",
          queries: ["a", "b", "c", "d"],
          max_results: 2,
          max_characters: 100,
          signal: new AbortController().signal,
        },
        { EXA_API_KEY: "x" },
      ),
    ).rejects.toThrow();
  });
});
it("uses Anthropic native bounded search and citation occurrences", async () => {
  let body: Record<string, unknown> = {};
  let endpoint = "";
  const raw = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [
      { type: "server_tool_use", id: "tool_1", name: "web_search", input: { query: "q" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "tool_1",
        content: [
          {
            type: "web_search_result",
            url: "https://a.test",
            title: "A",
            encrypted_content: "x",
            page_age: null,
          },
        ],
      },
      {
        type: "text",
        text: "Answer",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://a.test",
            title: "A",
            cited_text: "Answer",
            encrypted_index: "i",
          },
        ],
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 4, server_tool_use: { web_search_requests: 1 } },
  };
  const result = await executeProvider(
    input("anthropic"),
    { ANTHROPIC_API_KEY: "x" },
    {
      fetch: async (u, i) => {
        endpoint = String(u);
        body = JSON.parse(String(i?.body));
        return response(raw);
      },
    },
  );
  expect(endpoint).toBe("https://api.anthropic.com/v1/messages");
  expect(body.tools).toEqual([
    expect.objectContaining({ type: "web_search_20250305", max_uses: 1 }),
  ]);
  expect(result.citations).toHaveLength(1);
  expect(result.sources).toHaveLength(1);
  expect(result.raw_response).toEqual(raw);
});
it("uses OpenRouter server search without claiming a proven native engine", async () => {
  let body: Record<string, unknown> = {};
  const raw = {
    id: "r",
    model: "test-model",
    provider: "Provider X",
    object: "chat.completion",
    created: 1,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Answer",
          annotations: [
            {
              type: "url_citation",
              url_citation: { url: "https://a.test", title: "A", start_index: 0, end_index: 6 },
            },
          ],
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      cost: 0.01,
      server_tool_use: { web_search_requests: 1 },
    },
  };
  const result = await executeProvider(
    input("openrouter"),
    { OPENROUTER_API_KEY: "x" },
    {
      fetch: async (_u, i) => {
        body = JSON.parse(String(i?.body));
        return response(raw);
      },
    },
  );
  expect(body.tools).toEqual([
    { type: "openrouter:web_search", parameters: { engine: "native", max_uses: 1 } },
  ]);
  expect(body.provider).toEqual({ allow_fallbacks: false });
  expect(result.serving_provider).toBe("Provider X");
  expect(result.search_activity).toMatchObject({ observed: "executed", engine: null });
  expect(result.citations).toHaveLength(1);
  expect(result.usage.reported_cost_usd).toBe(0.01);
});
it("honors a pre-aborted signal without making a request", async () => {
  let calls = 0;
  const request = input();
  const controller = new AbortController();
  controller.abort();
  request.signal = controller.signal;
  await expect(
    executeProvider(
      request,
      { OPENAI_API_KEY: "x" },
      {
        fetch: async () => {
          calls++;
          return response(openai);
        },
      },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
it("validates legacy Vertex base64 credentials without interpreting them as API keys", async () => {
  const { targetAvailability } = await import("../src/targets.js");
  const request = input("vertex");
  expect(
    targetAvailability(request.target, { GOOGLE_APPLICATION_CREDENTIALS: "not-json" }).available,
  ).toBe(false);
  const encoded = Buffer.from(
    JSON.stringify({
      project_id: "p",
      client_email: "a@p.iam.gserviceaccount.com",
      private_key: "key",
    }),
  ).toString("base64");
  expect(
    targetAvailability(request.target, { GOOGLE_APPLICATION_CREDENTIALS: encoded }).available,
  ).toBe(true);
});
it("keeps absent usage counters null while retaining raw provider details", async () => {
  const raw = {
    ...openai,
    usage: { input_tokens: 12, output_tokens: 8, provider_extension: { opaque: true } },
  };
  const result = await executeProvider(
    input(),
    { OPENAI_API_KEY: "x" },
    { fetch: async () => response(raw) },
  );
  expect(result.usage.cached_tokens).toBeNull();
  expect(result.usage.reasoning_tokens).toBeNull();
  expect(result.usage.raw).toEqual(raw.usage);
  expect(result.raw_response).toEqual(raw);
});
it("keeps repeated citation occurrences instead of deduplicating URLs", async () => {
  const message = {
    id: "m",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: "Answer",
        annotations: [
          { type: "url_citation", url: "https://a.test", title: "A", start_index: 0, end_index: 1 },
          { type: "url_citation", url: "https://a.test", title: "A", start_index: 2, end_index: 3 },
        ],
      },
    ],
  };
  const result = await executeProvider(
    input(),
    { OPENAI_API_KEY: "x" },
    { fetch: async () => response({ ...openai, output: [message] }) },
  );
  expect(result.citations).toHaveLength(2);
  expect(result.sources).toHaveLength(0);
});
it("treats an invalid HTTP 200 generation response as ambiguous instead of provider rejection", async () => {
  await expect(
    executeProvider(
      input(),
      { OPENAI_API_KEY: "x" },
      { fetch: async () => response({ unexpected: "shape" }) },
    ),
  ).rejects.toMatchObject({ code: "provider_error" });
});
it.each(["failed", "cancelled"])(
  "rejects a Perplexity HTTP 200 %s outcome and retains usage safely",
  async (status) => {
    const raw = {
      id: "r",
      model: "test-model",
      status,
      error: { code: "vendor_code", message: "DO NOT COPY VENDOR BODY" },
      output: [],
      usage: { input_tokens: 7, output_tokens: 2 },
    };
    let failure: unknown;
    try {
      await executeProvider(
        input("perplexity"),
        { PERPLEXITY_API_KEY: "x" },
        { fetch: async () => response(raw) },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: `provider_${status}`,
      result: {
        raw_response: raw,
        usage: { input_tokens: 7, output_tokens: 2 },
        finish_reason: status,
      },
    });
    expect((failure as Error).message).not.toContain("DO NOT COPY");
  },
);
it.each([
  {},
  { status: "completed", output: [] },
  {
    id: "r",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "" }] }],
  },
])("rejects a malformed or empty Perplexity HTTP 200 response", async (raw) => {
  await expect(
    executeProvider(
      input("perplexity"),
      { PERPLEXITY_API_KEY: "x" },
      { fetch: async () => response(raw) },
    ),
  ).rejects.toMatchObject({ code: "provider_invalid_response" });
});
it("preserves incomplete partial output with an explicit truncation warning", async () => {
  const raw = {
    id: "r",
    model: "test-model",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: "Partial answer" }] }],
  };
  const result = await executeProvider(
    input("perplexity"),
    { PERPLEXITY_API_KEY: "x" },
    { fetch: async () => response(raw) },
  );
  expect(result.answer).toBe("Partial answer");
  expect(result.finish_reason).toBe("incomplete");
  expect(result.warnings.join(" ")).toMatch(/incomplete|truncat/i);
  expect(result.raw_response).toEqual(raw);
});
it("distinguishes a genuine refusal from malformed blank output", async () => {
  const raw = {
    id: "r",
    model: "test-model",
    status: "completed",
    output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot assist" }] }],
  };
  const result = await executeProvider(
    input("perplexity"),
    { PERPLEXITY_API_KEY: "x" },
    { fetch: async () => response(raw) },
  );
  expect(result.warnings.join(" ")).toMatch(/refus/i);
  expect(result.raw_response).toEqual(raw);
});
it("rejects a controlled Perplexity grounded model with cached retrieval before HTTP", async () => {
  let calls = 0;
  const request = input("perplexity", { mode: "controlled", engine: "exa" });
  request.target.model = "perplexity/sonar";
  request.retrieval = {
    id: "cached",
    queries: ["q"],
    sources: [],
    context: "cached context",
    raw_response: [],
    estimated_cost_usd: 0.02,
    reported_cost_usd: null,
    created_at: new Date().toISOString(),
  };
  await expect(
    executeProvider(
      request,
      { PERPLEXITY_API_KEY: "x" },
      {
        fetch: async () => {
          calls++;
          return response({});
        },
      },
    ),
  ).rejects.toMatchObject({ code: "unsupported_configuration" });
  expect(calls).toBe(0);
});
it("preserves OpenAI incomplete output and native truncation reason", async () => {
  const raw = {
    ...openai,
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  };
  const result = await executeProvider(
    input(),
    { OPENAI_API_KEY: "x" },
    { fetch: async () => response(raw) },
  );
  expect(result.finish_reason).toBe("incomplete");
  expect(result.warnings.join(" ")).toMatch(/truncat/i);
  expect(result.raw_response).toEqual(raw);
});
it("classifies a captured OpenAI failed outcome even when the SDK throws", async () => {
  const raw = {
    ...openai,
    status: "failed",
    output: [],
    error: { code: "server_error", message: "PRIVATE VENDOR DETAIL" },
  };
  await expect(
    executeProvider(input(), { OPENAI_API_KEY: "x" }, { fetch: async () => response(raw) }),
  ).rejects.toMatchObject({
    code: "provider_failed",
    result: { raw_response: raw, usage: { input_tokens: 12 } },
  });
});
it("preserves an Anthropic refusal without calling it malformed empty output", async () => {
  const raw = {
    id: "msg_refusal",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [],
    stop_reason: "refusal",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 0 },
  };
  const result = await executeProvider(
    input("anthropic"),
    { ANTHROPIC_API_KEY: "x" },
    { fetch: async () => response(raw) },
  );
  expect(result.answer).toBe("");
  expect(result.warnings.join(" ")).toMatch(/refus/i);
  expect(result.raw_response).toEqual(raw);
});
it("rejects a Perplexity completed status that carries a vendor error", async () => {
  const raw = {
    id: "r",
    model: "test-model",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "Partial" }] }],
    error: { code: "failed", message: "DO NOT COPY" },
  };
  await expect(
    executeProvider(
      input("perplexity"),
      { PERPLEXITY_API_KEY: "x" },
      { fetch: async () => response(raw) },
    ),
  ).rejects.toMatchObject({
    code: "provider_failed",
    result: { answer: "Partial", raw_response: raw },
  });
});
it("leaves cost unknown when native search has a positive price and no usage count", async () => {
  const request = input();
  request.target.pricing = {
    input_per_million: 1,
    output_per_million: 2,
    search_per_request: 0.01,
  };
  const result = await executeProvider(
    request,
    { OPENAI_API_KEY: "x" },
    { fetch: async () => response({ ...openai, output: openai.output.slice(1) }) },
  );
  expect(result.usage.search_requests).toBeNull();
  expect(result.usage.estimated_cost_usd).toBeNull();
});
