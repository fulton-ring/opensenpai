import { expect, it } from "vitest";
import { RetrievalResponseError, retrieveExa } from "../../src/providers/index.js";

const raw = {
  results: [{ url: "https://source.test", title: "Source", text: "Evidence" }],
  costDollars: { total: 0.004 },
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const input = () => ({
  id: "bundle",
  queries: ["first", "second"],
  max_results: 2,
  max_characters: 1000,
  signal: AbortSignal.timeout(5000),
});
it.each([400, 503])(
  "preserves earlier query evidence when a later HTTP %i response fails",
  async (status) => {
    let calls = 0;
    let failure: unknown;
    try {
      await retrieveExa(
        input(),
        { EXA_API_KEY: "test" },
        {
          fetch: async () =>
            ++calls === 1 ? response(raw) : response({ error: "PRIVATE PROVIDER DETAIL" }, status),
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(calls).toBe(2);
    expect(failure).toBeInstanceOf(RetrievalResponseError);
    expect(failure).toMatchObject({
      unknown: status === 503,
      bundle: {
        queries: ["first"],
        sources: [{ url: "https://source.test" }],
        context: expect.stringContaining("Evidence"),
        estimated_cost_usd: 0.04,
        reported_cost_usd: status === 503 ? null : 0.004,
        raw_response: {
          responses: [raw],
          completed_reported_cost_usd: 0.004,
          failure: { query_index: 1, query: "second", dispatched: true },
        },
      },
    });
    expect((failure as Error).message).not.toContain("PRIVATE");
  },
);
it("holds the full reservation after a later ambiguous network failure", async () => {
  let calls = 0;
  await expect(
    retrieveExa(
      input(),
      { EXA_API_KEY: "test" },
      {
        fetch: async () => {
          if (++calls === 1) return response(raw);
          throw new TypeError("PRIVATE NETWORK DETAIL");
        },
      },
    ),
  ).rejects.toMatchObject({
    unknown: true,
    bundle: {
      reported_cost_usd: null,
      raw_response: { responses: [raw], completed_reported_cost_usd: 0.004 },
    },
  });
  expect(calls).toBe(2);
});
it("preserves completed evidence when a later request is aborted after dispatch", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(
    retrieveExa(
      { ...input(), signal: controller.signal },
      { EXA_API_KEY: "test" },
      {
        fetch: async () => {
          if (++calls === 1) return response(raw);
          controller.abort();
          throw controller.signal.reason;
        },
      },
    ),
  ).rejects.toMatchObject({
    unknown: true,
    bundle: {
      reported_cost_usd: null,
      raw_response: { responses: [raw], failure: { dispatched: true } },
    },
  });
  expect(calls).toBe(2);
});
it("settles completed queries without an unknown charge when aborted before the next dispatch", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(
    retrieveExa(
      { ...input(), signal: controller.signal },
      { EXA_API_KEY: "test" },
      {
        fetch: async () => {
          calls++;
          const value = response(raw);
          value.json = async () => {
            controller.abort();
            return raw;
          };
          return value;
        },
      },
    ),
  ).rejects.toMatchObject({
    unknown: false,
    bundle: {
      reported_cost_usd: 0.004,
      queries: ["first"],
      raw_response: { failure: { dispatched: false } },
    },
  });
  expect(calls).toBe(1);
});
it("keeps missing completed-query costs unknown even after a known rejection", async () => {
  let calls = 0;
  await expect(
    retrieveExa(
      input(),
      { EXA_API_KEY: "test" },
      {
        fetch: async () => (++calls === 1 ? response({ results: raw.results }) : response({}, 400)),
      },
    ),
  ).rejects.toMatchObject({
    unknown: false,
    bundle: { reported_cost_usd: null, raw_response: { completed_reported_cost_usd: null } },
  });
});
