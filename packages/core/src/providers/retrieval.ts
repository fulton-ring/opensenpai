import { ResearchError, type RetrievalBundle, type Source } from "../contracts.js";
import { type Json, num, obj, records, source } from "./normalize.js";
import type { ProviderEnvironment, RetrievalInput, RetrievalProvider } from "./types.js";

export const EXA_ESTIMATED_COST_PER_QUERY = 0.02;
export const EXA_SEARCH_ESTIMATE_USD = EXA_ESTIMATED_COST_PER_QUERY;

async function http(
  fetcher: typeof fetch,
  url: string,
  body: unknown,
  key: string,
  signal: AbortSignal,
): Promise<Json> {
  signal.throwIfAborted();
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
async function retrieveExa(
  input: RetrievalInput,
  env: ProviderEnvironment,
  options: { fetch?: typeof fetch } = {},
): Promise<RetrievalBundle> {
  checkRetrieval(input, env);
  const sources: Source[] = [];
  const responses: Json[] = [];
  let reported = 0;
  let allReported = true;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]);
  for (const query of input.queries) {
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
    );
    responses.push(raw);
    const cost = num(obj(raw.costDollars).total);
    if (cost === null) allReported = false;
    else reported += cost;
    for (const result of records(raw.results)) {
      const s = source(result);
      if (s && !sources.some((v) => v.url === s.url)) sources.push(s);
    }
  }
  const context = sources
    .map((s, i) => `[${i + 1}] ${s.title ?? "Untitled"}\n${s.url}\n${s.text ?? ""}`)
    .join("\n\n")
    .slice(0, input.max_characters);
  return {
    id: input.id,
    queries: [...input.queries],
    sources,
    context,
    raw_response: responses,
    estimated_cost_usd: input.queries.length * EXA_SEARCH_ESTIMATE_USD,
    reported_cost_usd: allReported ? reported : null,
    created_at: new Date().toISOString(),
  };
}

export const exaProvider: RetrievalProvider = {
  availability: ({ env }) => ({
    available: Boolean(env.EXA_API_KEY?.trim()),
    ...(!env.EXA_API_KEY?.trim() ? { reason: "Missing EXA_API_KEY" } : {}),
  }),
  estimate: (input) => input.queries.length * EXA_SEARCH_ESTIMATE_USD,
  retrieve: (input, context) => retrieveExa(input, context.env, { fetch: context.fetch }),
};
