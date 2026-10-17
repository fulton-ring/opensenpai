import type { LanguageModelUsage } from "ai";
import type { Citation, ProviderInput, ProviderResult, Source } from "../contracts.js";
export type Json = Record<string, unknown>;
export const obj = (value: unknown): Json =>
  value && typeof value === "object" ? (value as Json) : {};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const records = (value: unknown): Json[] => arr(value).map(obj);
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const isUrl = (value: unknown): value is string =>
  typeof value === "string" && /^https?:\/\//i.test(value);
export function source(value: unknown): Source | null {
  const s = obj(value);
  const url = s.url ?? s.uri;
  return isUrl(url) ? { url, title: str(s.title), text: str(s.text), metadata: value } : null;
}
export function uniqueSources(values: Source[]): Source[] {
  return values.filter((s, i) => values.findIndex((v) => v.url === s.url) === i);
}
interface Evidence {
  sources: Source[];
  citations: Citation[];
  searches: number | null;
  engine: string | null;
  executed: boolean;
}
const empty = (): Evidence => ({
  sources: [],
  citations: [],
  searches: null,
  engine: null,
  executed: false,
});
function citation(value: unknown): Citation | null {
  const a = obj(value);
  const c = obj(a.url_citation ?? a);
  return isUrl(c.url)
    ? {
        url: c.url,
        title: str(c.title),
        start_index: num(c.start_index) ?? undefined,
        end_index: num(c.end_index) ?? undefined,
        cited_text: str(c.cited_text),
        locator_units: "provider_defined",
        metadata: value,
      }
    : null;
}
function annotations(values: unknown): Citation[] {
  return records(values)
    .filter((a) => a.type === "url_citation")
    .map(citation)
    .filter((c) => c !== null);
}
function responseEvidence(raw: Json): Evidence {
  const e = empty();
  for (const output of records(raw.output)) {
    if (["web_search_call", "search_results"].includes(String(output.type))) {
      e.searches = (e.searches ?? 0) + 1;
      e.sources.push(
        ...records(obj(output.action).sources)
          .map(source)
          .filter((s) => s !== null),
        ...records(output.results)
          .map(source)
          .filter((s) => s !== null),
      );
    }
    for (const c of records(output.content)) e.citations.push(...annotations(c.annotations));
  }
  return e;
}
function anthropicEvidence(raw: Json): Evidence {
  const e = empty();
  for (const c of records(raw.content)) {
    if (c.type === "server_tool_use" && c.name === "web_search") e.searches = (e.searches ?? 0) + 1;
    if (c.type === "web_search_tool_result")
      e.sources.push(
        ...records(c.content)
          .map(source)
          .filter((s) => s !== null),
      );
    e.citations.push(
      ...records(c.citations)
        .map(citation)
        .filter((c) => c !== null),
    );
  }
  return e;
}
function vertexEvidence(raw: Json): Evidence {
  const e = empty();
  for (const candidate of records(raw.candidates)) {
    const grounding = obj(candidate.groundingMetadata);
    const chunks = records(grounding.groundingChunks);
    e.sources.push(...chunks.map((c) => source(c.web)).filter((s) => s !== null));
    const queries = arr(grounding.webSearchQueries);
    if (queries.length) {
      e.searches = (e.searches ?? 0) + queries.length;
      e.engine = "google";
    }
    for (const support of records(grounding.groundingSupports)) {
      const segment = obj(support.segment);
      for (const index of arr(support.groundingChunkIndices)) {
        const web = obj(obj(chunks[Number(index)]).web);
        if (isUrl(web.uri))
          e.citations.push({
            url: web.uri,
            title: str(web.title),
            start_index: num(segment.startIndex) ?? undefined,
            end_index: num(segment.endIndex) ?? undefined,
            cited_text: str(segment.text),
            locator_units: "provider_defined",
            metadata: support,
          });
      }
    }
  }
  return e;
}
function evidence(input: ProviderInput, raw: Json): Evidence {
  const parsers = {
    openai: responseEvidence,
    perplexity: responseEvidence,
    anthropic: anthropicEvidence,
    vertex: vertexEvidence,
    openrouter: responseEvidence,
  };
  const e = parsers[input.target.transport](raw);
  for (const choice of records(raw.choices))
    e.citations.push(...annotations(obj(choice.message).annotations));
  const usage = obj(raw.usage ?? raw.usageMetadata);
  e.searches =
    num(obj(usage.server_tool_use).web_search_requests) ??
    num(obj(usage.server_tool_usage).web_search_requests) ??
    num(usage.num_search_queries) ??
    e.searches;
  e.engine =
    input.target.transport === "openrouter"
      ? (str(raw.search_engine) ?? null)
      : (e.engine ?? (e.searches === null ? null : input.target.transport));
  e.sources = uniqueSources(e.sources);
  e.executed = e.searches !== null && e.searches > 0;
  return e;
}
function warnings(input: ProviderInput, searches: number | null): string[] {
  if (input.target.search.mode !== "native") return [];
  const messages = [];
  if (searches === null)
    messages.push("Search was requested; the provider did not report execution evidence.");
  if (input.target.transport === "openrouter")
    messages.push(
      "OpenRouter native search may fall back to another engine; engine is unknown unless reported.",
    );
  if (["openai", "vertex"].includes(input.target.transport))
    messages.push("Native search max_uses is an estimate, not a provider-enforced hard cap.");
  return messages;
}
export interface NormalizationContext {
  responses?: Json[];
  sdk_usage?: LanguageModelUsage;
}
function sumCounts(values: (number | null)[]): number | null {
  return values.some((v) => v === null)
    ? null
    : values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
}
function combinedEvidence(input: ProviderInput, responses: Json[]): Evidence {
  const items = responses.map((raw) => evidence(input, raw));
  const engines = [...new Set(items.map((e) => e.engine).filter((e) => e !== null))];
  return {
    sources: uniqueSources(items.flatMap((e) => e.sources)),
    citations: items.flatMap((e) => e.citations),
    searches: sumCounts(items.map((e) => e.searches)),
    engine: engines.length === 1 ? (engines[0] ?? null) : null,
    executed: items.some((e) => e.executed),
  };
}
function rawTokens(raw: Json) {
  const u = obj(raw.usage ?? raw.usageMetadata);
  const googleInput = num(u.promptTokenCount),
    googleOutput = num(u.candidatesTokenCount);
  return {
    input:
      num(u.input_tokens ?? u.prompt_tokens) ??
      (googleInput === null ? null : googleInput + (num(u.toolUsePromptTokenCount) ?? 0)),
    output:
      num(u.output_tokens ?? u.completion_tokens) ??
      (googleOutput === null ? null : googleOutput + (num(u.thoughtsTokenCount) ?? 0)),
    reasoning: num(
      obj(u.output_tokens_details ?? u.completion_tokens_details).reasoning_tokens ??
        u.thoughtsTokenCount,
    ),
    cached: num(
      obj(u.input_tokens_details ?? u.prompt_tokens_details).cached_tokens ??
        u.cache_read_input_tokens ??
        u.cachedContentTokenCount,
    ),
    cost: num(u.cost) ?? num(obj(u.cost).total_cost) ?? num(u.total_cost),
    raw: u,
  };
}
function usage(
  input: ProviderInput,
  responses: Json[],
  searches: number | null,
  sdk?: LanguageModelUsage,
): ProviderResult["usage"] {
  const tokens = responses.map(rawTokens);
  const rawInput = sumCounts(tokens.map((t) => t.input)),
    rawOutput = sumCounts(tokens.map((t) => t.output));
  const inputTokens = rawInput === null ? null : (num(sdk?.inputTokens) ?? rawInput),
    outputTokens = rawOutput === null ? null : (num(sdk?.outputTokens) ?? rawOutput);
  const rawReasoning = sumCounts(tokens.map((t) => t.reasoning)),
    rawCached = sumCounts(tokens.map((t) => t.cached));
  const price = input.target.pricing;
  const unknownSearchCost =
    input.target.search.mode === "native" &&
    searches === null &&
    (price?.search_per_request ?? 0) > 0;
  const estimated =
    price && inputTokens !== null && outputTokens !== null && !unknownSearchCost
      ? (inputTokens * price.input_per_million + outputTokens * price.output_per_million) / 1e6 +
        (searches ?? 0) * price.search_per_request
      : null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens:
      rawReasoning === null ? null : (num(sdk?.outputTokenDetails.reasoningTokens) ?? rawReasoning),
    cached_tokens:
      rawCached === null ? null : (num(sdk?.inputTokenDetails.cacheReadTokens) ?? rawCached),
    search_requests: searches,
    reported_cost_usd: sumCounts(tokens.map((t) => t.cost)),
    estimated_cost_usd: estimated,
    raw:
      responses.length === 1
        ? tokens[0]?.raw
        : { responses: tokens.map((t) => t.raw), sdk_aggregate: sdk ?? null },
  };
}
function searchActivity(input: ProviderInput, e: Evidence): ProviderResult["search_activity"] {
  if (input.target.search.mode === "controlled")
    return { requested: "controlled", observed: "executed", engine: "exa" };
  const observed = e.executed
    ? "executed"
    : e.searches === null
      ? input.target.search.mode === "off"
        ? "not_observed"
        : "unknown"
      : e.searches > 0
        ? "executed"
        : "not_observed";
  return { requested: input.target.search.mode, observed, engine: e.engine };
}
export function normalize(
  input: ProviderInput,
  raw: Json,
  answer: string,
  finish: string | null,
  context: NormalizationContext = {},
): ProviderResult {
  const responses = context.responses?.length ? context.responses : [raw];
  const e = combinedEvidence(input, responses);
  return {
    answer,
    requested_model: input.target.model,
    model: str(raw.model) ?? str(raw.modelVersion) ?? input.target.model,
    serving_provider:
      str(raw.provider) ??
      (input.target.transport === "openrouter" ? null : input.target.transport),
    response_id: str(raw.id) ?? str(raw.responseId) ?? null,
    finish_reason: finish,
    sources: input.retrieval?.sources ?? e.sources,
    citations: e.citations,
    extracted_urls: [
      ...new Set(
        (answer.match(/https?:\/\/[^\s<>"\]]+/g) ?? []).map((s) => s.replace(/[.,;:!?)]+$/, "")),
      ),
    ],
    search_activity: searchActivity(input, e),
    usage: usage(input, responses, e.searches, context.sdk_usage),
    raw_response: responses.length === 1 ? raw : { responses },
    warnings: warnings(input, e.searches),
  };
}
