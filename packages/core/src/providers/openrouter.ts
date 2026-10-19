import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  type ProviderInput,
  type ProviderResult,
  ResearchError,
  type Target,
} from "../contracts.js";
import { arr, num, obj, records, str } from "./normalize.js";
import { ProviderResponseError } from "./outcomes.js";
import { createSdkProvider } from "./sdk.js";
import type { ModelProvider, ProviderContext } from "./types.js";

interface RouterOptions {
  apiKeyEnv?: string;
  nativeSearch?: { apiKeyEnv: string };
}

interface Endpoint {
  tag: string;
  providerName: string;
}

const root = "https://openrouter.ai/api/v1";

const searchEnabled = (target: Target) =>
  target.search.mode === "native" || target.search.mode === "server";

const sonar = (target: Target) => target.model.startsWith("perplexity/sonar");

function apiKeyEnv(options: RouterOptions, target: Target) {
  return target.search.mode === "native"
    ? (options.nativeSearch?.apiKeyEnv ?? options.apiKeyEnv ?? "OPENROUTER_API_KEY")
    : (options.apiKeyEnv ?? "OPENROUTER_API_KEY");
}

function availability(options: RouterOptions, target: Target, context: ProviderContext) {
  const key = apiKeyEnv(options, target);
  if (!context.env[key]?.trim()) return { available: false, reason: `Missing ${key}` };
  if (target.model.includes(":online"))
    return { available: false, reason: "Use explicit search configuration instead of :online" };
  if (sonar(target) && target.search.mode !== "native")
    return { available: false, reason: "Sonar intrinsically searches; select native search" };
  if (
    target.search.mode === "server" &&
    !["exa", "perplexity", "parallel", "firecrawl"].includes(target.search.engine)
  )
    return { available: false, reason: "Unsupported OpenRouter server search engine" };
  return { available: true };
}

function eligible(target: Target, value: Record<string, unknown>) {
  if (!str(value.tag)?.trim() || !str(value.provider_name)?.trim()) return false;
  if (value.status !== undefined && value.status !== 0) return false;
  if (target.search.mode !== "native") return true;
  return (
    Boolean(str(obj(obj(value.native_tools)["openrouter:web_search"]).type)?.trim()) ||
    (sonar(target) && value.tag === "perplexity")
  );
}

async function catalogEndpoint(
  target: Target,
  context: ProviderContext,
  key: string,
  signal: AbortSignal,
) {
  const path = target.model.split("/").map(encodeURIComponent).join("/");
  const response = await context.fetch(`${root}/models/${path}/endpoints`, {
    headers: { authorization: `Bearer ${key}` },
    signal,
  });
  if (!response.ok) throw new Error("catalog unavailable");
  const body = obj(obj(await response.json()).data);
  if (body.id !== undefined && body.id !== target.model) throw new Error("model mismatch");
  const tag = str(target.provider_options?.provider);
  const selected = records(body.endpoints).find(
    (value) => (!tag || value.tag === tag) && eligible(target, value),
  );
  if (!selected || (selected.model_id !== undefined && selected.model_id !== target.model))
    throw new Error("endpoint unavailable");
  return selected;
}

async function endpoint(
  input: ProviderInput,
  context: ProviderContext,
  key: string,
): Promise<Endpoint> {
  try {
    const selected = await catalogEndpoint(input.target, context, key, input.signal);
    return { tag: String(selected.tag), providerName: String(selected.provider_name) };
  } catch {
    throw new ResearchError(
      "provider_not_dispatched",
      "Pinned endpoint does not advertise the required capability",
    );
  }
}

function amount(value: unknown): number | undefined {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
  )
    return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function pricing(target: Target, selected: Record<string, unknown>): Target["pricing"] {
  const values = obj(selected.pricing);
  const prompt = amount(values.prompt),
    completion = amount(values.completion);
  // Server-tool defaults are pinned to five results. Prices verified 2026-10-17:
  // https://openrouter.ai/docs/guides/features/server-tools/web-search#pricing
  const server: Record<string, number> = {
    exa: 0.007,
    perplexity: 0.005,
    parallel: 0.005,
    firecrawl: 0.0675,
  };
  const search =
    target.search.mode === "native"
      ? amount(values.web_search)
      : target.search.mode === "server"
        ? server[target.search.engine]
        : 0;
  if (prompt === undefined || completion === undefined || search === undefined) return undefined;
  const input = prompt * 1e6,
    output = completion * 1e6;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return { input_per_million: input, output_per_million: output, search_per_request: search };
}

async function resolveTarget(
  options: RouterOptions,
  target: Target,
  context: ProviderContext,
): Promise<Target> {
  const available = availability(options, target, context);
  if (!available.available)
    throw new ResearchError("target_unavailable", available.reason ?? "Target unavailable");
  try {
    const key = context.env[apiKeyEnv(options, target) ?? ""] ?? "";
    const selected = await catalogEndpoint(target, context, key, AbortSignal.timeout(15_000));
    return {
      ...target,
      provider_options: { ...target.provider_options, provider: String(selected.tag) },
      pricing: pricing(target, selected),
    };
  } catch {
    throw new ResearchError(
      "target_unavailable",
      "Model or serving endpoint is unavailable for the selected search mode",
    );
  }
}

async function listModels(query: { query?: string; limit: number }, context: ProviderContext) {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50)
    throw new ResearchError("invalid_model_query", "Model query limit must be between 1 and 50");
  try {
    const response = await context.fetch(`${root}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error();
    const data = obj(await response.json()).data;
    if (!Array.isArray(data)) throw new Error();
    const term = query.query?.toLowerCase() ?? "";
    return records(data)
      .filter(
        (model) =>
          str(model.id)?.trim() &&
          `${model.id} ${str(model.name) ?? ""}`.toLowerCase().includes(term),
      )
      .slice(0, query.limit)
      .map((model) => ({
        id: String(model.id),
        ...(str(model.name) ? { name: String(model.name) } : {}),
      }));
  } catch {
    throw new ResearchError(
      "provider_catalog_unavailable",
      "OpenRouter model catalog is unavailable",
    );
  }
}

function requestBody(input: ProviderInput, selected: Endpoint | null) {
  const search = input.target.search;
  return {
    provider: {
      allow_fallbacks: false,
      ...(selected
        ? { only: [selected.tag], order: [selected.tag], require_parameters: true }
        : {}),
    },
    ...(input.target.reasoning_effort
      ? { reasoning: { effort: input.target.reasoning_effort } }
      : {}),
    ...(searchEnabled(input.target) && !sonar(input.target)
      ? {
          tools: [
            {
              type: "openrouter:web_search",
              parameters: {
                engine: search.mode === "server" ? search.engine : "native",
                ...(search.mode === "server" ? { max_results: 5 } : {}),
                max_uses: "max_uses" in search ? search.max_uses : 1,
              },
            },
          ],
          max_tool_calls: "max_uses" in search ? search.max_uses : 1,
        }
      : {}),
  };
}

async function metadata(
  responseId: string | null,
  context: ProviderContext,
  key: string,
  signal: AbortSignal,
) {
  if (!responseId) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100));
    signal.throwIfAborted();
    try {
      const response = await context.fetch(
        `${root}/generation?id=${encodeURIComponent(responseId)}`,
        { headers: { authorization: `Bearer ${key}` }, signal },
      );
      if (response.ok) return obj(obj(await response.json()).data);
      if (![404, 429, 503].includes(response.status)) return null;
    } catch {
      if (signal.aborted) throw signal.reason;
    }
  }
  return null;
}

async function generationMetadata(
  result: ProviderResult,
  context: ProviderContext,
  key: string,
  signal: AbortSignal,
) {
  const responses = responseBodies(result);
  const items: (Record<string, unknown> | null)[] = [];
  for (const response of responses) {
    try {
      items.push(await metadata(str(response.id) ?? null, context, key, signal));
    } catch {
      items.push(null);
    }
  }
  return items;
}

function responseBodies(result: ProviderResult) {
  const raw = obj(result.raw_response);
  return Array.isArray(raw.responses) ? records(raw.responses) : [raw];
}

function searchStages(response: Record<string, unknown>) {
  return records(obj(response.openrouter_metadata).pipeline)
    .filter(
      (stage) =>
        stage.type === "server_tools" &&
        stage.name === "server-tools" &&
        arr(obj(stage.data).tools).includes("openrouter:web_search"),
    )
    .map((stage) => obj(stage.data));
}

function responseEngines(response: Record<string, unknown>) {
  return searchStages(response).flatMap((stage) => {
    const engines = arr(obj(stage.executed_engines)["openrouter:web_search"]).map(
      (engine) => str(engine) ?? "unknown",
    );
    return stage.mode === "native" ? ["native", ...engines] : engines;
  });
}

function responseProof(
  response: Record<string, unknown>,
  target: Target,
  selected: Endpoint | null,
  engine: string,
) {
  const stages = searchStages(response);
  const engines = responseEngines(response);
  return (
    response.model === target.model &&
    response.provider === selected?.providerName &&
    obj(response.openrouter_metadata).requested === target.model &&
    stages.length > 0 &&
    stages.every((stage) => stage.mode === (engine === "native" ? "native" : "sdk")) &&
    engines.length > 0 &&
    engines.every((value) => value === engine)
  );
}

function intrinsicSonarProof(
  response: Record<string, unknown>,
  target: Target,
  selected: Endpoint | null,
) {
  const metadata = obj(response.openrouter_metadata);
  return (
    sonar(target) &&
    target.search.mode === "native" &&
    selected?.providerName === "Perplexity" &&
    response.provider === "Perplexity" &&
    response.model === target.model &&
    metadata.requested === target.model &&
    metadata.strategy === "direct" &&
    metadata.attempt === 1 &&
    responseEngines(response).every((engine) => engine === "native") &&
    arr(response.choices).some((choice) =>
      arr(obj(obj(choice).message).annotations).some(
        (annotation) =>
          obj(annotation).type === "url_citation" &&
          /^https?:\/\//.test(str(obj(obj(annotation).url_citation).url) ?? ""),
      ),
    )
  );
}

function searchProof(
  response: Record<string, unknown>,
  generation: Record<string, unknown> | null,
  target: Target,
  selected: Endpoint | null,
  engine: string,
) {
  const facts = [
    [str(response.model), target.model],
    [str(response.provider), selected?.providerName],
    [str(obj(response.openrouter_metadata).requested), target.model],
    [str(generation?.model), target.model],
    [str(generation?.provider_name), selected?.providerName],
    [str(generation?.web_search_engine), engine],
  ];
  if (facts.some(([actual, expected]) => actual !== undefined && actual !== expected)) return false;
  if (responseEngines(response).some((value) => value !== engine)) return false;
  return (
    responseProof(response, target, selected, engine) ||
    intrinsicSonarProof(response, target, selected) ||
    (generation?.model === target.model &&
      generation?.provider_name === selected?.providerName &&
      generation?.web_search_engine === engine)
  );
}

function observedEngine(
  response: Record<string, unknown>,
  generation: Record<string, unknown> | null,
) {
  const engines = [...new Set(responseEngines(response))];
  return str(generation?.web_search_engine) ?? (engines.length === 1 ? engines[0] : null);
}

async function verify(
  result: ProviderResult,
  input: ProviderInput,
  context: ProviderContext,
  key: string,
  selected: Endpoint | null,
): Promise<ProviderResult> {
  if (!searchEnabled(input.target)) return result;
  const responses = responseBodies(result);
  const items = await generationMetadata(result, context, key, input.signal);
  result.raw_response = { generation: result.raw_response, generation_metadata: items };
  const costs = items.map((item) => num(item?.total_cost));
  if (costs.every((cost) => cost !== null))
    result.usage.reported_cost_usd = costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
  const expectedEngine =
    input.target.search.mode === "server" ? input.target.search.engine : "native";
  const engines = [
    ...new Set(responses.map((response, i) => observedEngine(response, items[i] ?? null))),
  ];
  result.search_activity.engine = engines.length === 1 ? (engines[0] ?? null) : null;
  const providers = [
    ...new Set(
      responses.map(
        (response, i) => str(items[i]?.provider_name) ?? str(response.provider) ?? null,
      ),
    ),
  ];
  result.serving_provider = providers.length === 1 ? (providers[0] ?? null) : null;
  const proved =
    responses.length > 0 &&
    responses.every((response, i) =>
      searchProof(response, items[i] ?? null, input.target, selected, expectedEngine),
    );
  const intrinsic =
    responses.length > 0 &&
    responses.every((response) => intrinsicSonarProof(response, input.target, selected));
  const searched =
    (result.usage.search_requests ?? 0) > 0 || (result.usage.search_requests === null && intrinsic);
  if (!searched || !proved)
    throw new ProviderResponseError(
      "search_proof_failed",
      "Search execution, engine, model or serving provider could not be verified",
      result,
    );
  if (intrinsic) result.search_activity.engine = "native";
  result.search_activity.observed = "executed";
  return result;
}

/** Filter model/search pairs against current OpenRouter capabilities, pin the route, and verify execution. */
export function createOpenRouterProvider(options: RouterOptions = {}): ModelProvider {
  return {
    availability: (target, context) => availability(options, target, context),
    resolveTarget: (target, context) => resolveTarget(options, target, context),
    listModels,
    execute: async (input, context) => {
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.target.timeout_ms)]);
      const request = { ...input, signal };
      const key = context.env[apiKeyEnv(options, input.target) ?? ""] ?? "";
      const selected = await endpoint(request, context, key);
      const sdk = createSdkProvider({
        createModel: (value, captured) => ({
          model: createOpenRouter({
            apiKey: key,
            fetch: captured.fetch,
            headers: { "X-OpenRouter-Metadata": "enabled" },
            extraBody: requestBody(value, selected),
          }).chat(value.target.model),
        }),
        verify: (result, value, original) => verify(result, value, original, key, selected),
      });
      return sdk.execute(request, context);
    },
  };
}
