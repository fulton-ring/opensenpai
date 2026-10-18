import { ResearchError, type RetrievalBundle, type Source } from "../contracts.js";
import { type Json, num, obj, records, source } from "./normalize.js";
import { RetrievalResponseError } from "./outcomes.js";
import type { ProviderEnvironment, RetrievalInput, RetrievalProvider } from "./types.js";

/** Conservative USD reservation for one direct Exa query; reported charges remain authoritative. */
export const EXA_ESTIMATED_COST_PER_QUERY = 0.02;

/** Compatibility alias for the direct Exa query reservation amount. */
export const EXA_SEARCH_ESTIMATE_USD = EXA_ESTIMATED_COST_PER_QUERY;

async function http(
  fetcher: typeof fetch,
  url: string,
  body: unknown,
  key: string,
  signal: AbortSignal,
  onDispatch: () => void,
): Promise<Json> {
  signal.throwIfAborted();
  onDispatch();
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(url.includes("api.exa.ai") ? { "x-api-key": key } : { Authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok)
    throw new ResearchError(
      `provider_http_${response.status}`,
      `Provider rejected request (HTTP ${response.status})`,
      response.status === 429 || response.status >= 500,
    );
  return obj(await response.json());
}

function checkRetrieval(input: RetrievalInput, env: ProviderEnvironment) {
  const validQueries =
    input.queries.length >= 1 &&
    input.queries.length <= 3 &&
    input.queries.every((q) => q.trim() && q.length <= 8000);
  const validResults =
    Number.isInteger(input.max_results) && input.max_results >= 1 && input.max_results <= 10;
  const validContext =
    Number.isInteger(input.max_characters) &&
    input.max_characters >= 100 &&
    input.max_characters <= 30_000;
  if (!validQueries || !validResults || !validContext)
    throw new ResearchError("invalid_retrieval", "Invalid retrieval query or limits");
  if (!env.EXA_API_KEY?.trim())
    throw new ResearchError("missing_credentials", "Missing EXA_API_KEY");
}

function completedCost(responses: Json[]) {
  const costs = responses.map((raw) => num(obj(raw.costDollars).total));
  if (costs.some((cost) => cost === null || cost < 0)) return null;
  return costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
}

function bundle(input: RetrievalInput, responses: Json[]): RetrievalBundle {
  const sources: Source[] = [];
  for (const raw of responses)
    for (const result of records(raw.results)) {
      const value = source(result);
      if (value && !sources.some((existing) => existing.url === value.url)) sources.push(value);
    }
  return {
    id: input.id,
    queries: input.queries.slice(0, responses.length),
    sources,
    context: sources
      .map(
        (value, index) =>
          `[${index + 1}] ${value.title ?? "Untitled"}\n${value.url}\n${value.text ?? ""}`,
      )
      .join("\n\n")
      .slice(0, input.max_characters),
    raw_response: responses,
    estimated_cost_usd: input.queries.length * EXA_SEARCH_ESTIMATE_USD,
    reported_cost_usd: completedCost(responses),
    created_at: new Date().toISOString(),
  };
}

function partialFailure(
  input: RetrievalInput,
  responses: Json[],
  queryIndex: number,
  dispatched: boolean,
  error: unknown,
): RetrievalResponseError {
  const knownRejected =
    error instanceof ResearchError && /^provider_http_(400|401|403|404|429)$/.test(error.code);
  const unknown = dispatched && !knownRejected;
  const partial = bundle(input, responses);
  partial.raw_response = {
    responses,
    completed_reported_cost_usd: partial.reported_cost_usd,
    failure: {
      query_index: queryIndex,
      query: input.queries[queryIndex],
      dispatched,
      code: error instanceof ResearchError ? error.code : "retrieval_error",
    },
  };
  if (unknown) partial.reported_cost_usd = null;
  return new RetrievalResponseError(
    "retrieval_partial_failure",
    "Retrieval did not complete; completed query evidence was retained",
    partial,
    unknown,
  );
}

async function retrieveExa(
  input: RetrievalInput,
  env: ProviderEnvironment,
  options: { fetch?: typeof fetch } = {},
): Promise<RetrievalBundle> {
  checkRetrieval(input, env);
  const responses: Json[] = [];
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]);
  for (const [index, query] of input.queries.entries()) {
    let dispatched = false;
    try {
      const raw = await http(
        options.fetch ?? fetch,
        "https://api.exa.ai/search",
        {
          query,
          type: "auto",
          numResults: input.max_results,
          contents: { text: { maxCharacters: input.max_characters } },
        },
        env.EXA_API_KEY ?? "",
        signal,
        () => {
          dispatched = true;
        },
      );
      responses.push(raw);
    } catch (error) {
      throw partialFailure(input, responses, index, dispatched, error);
    }
  }
  return bundle(input, responses);
}

/** Direct Exa retrieval adapter preserving exact results, ordered sources and reported query costs. */
export const exaProvider: RetrievalProvider = {
  availability: ({ env }) => ({
    available: Boolean(env.EXA_API_KEY?.trim()),
    ...(!env.EXA_API_KEY?.trim() ? { reason: "Missing EXA_API_KEY" } : {}),
  }),
  estimate: (input) => input.queries.length * EXA_SEARCH_ESTIMATE_USD,
  retrieve: (input, context) => retrieveExa(input, context.env, { fetch: context.fetch }),
};
