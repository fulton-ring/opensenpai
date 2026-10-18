import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  type ProviderInput,
  type ProviderResult,
  ResearchError,
  type Target,
} from "../contracts.js";
import { num, obj, records, str } from "./normalize.js";
import { ProviderResponseError } from "./outcomes.js";
import { createSdkProvider } from "./sdk.js";
import type { ModelProvider, ProviderContext } from "./types.js";

interface RouterOptions {
  apiKeyEnv?: string;
  nativeSearch?: { apiKeyEnv: string; policy: "workspace-native-only" };
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
    ? options.nativeSearch?.apiKeyEnv
    : (options.apiKeyEnv ?? "OPENROUTER_API_KEY");
}
function availability(options: RouterOptions, target: Target, context: ProviderContext) {
  const key = apiKeyEnv(options, target);
  if (!key || !context.env[key]?.trim())
    return {
      available: false,
      reason:
        target.search.mode === "native"
          ? "Native search requires a dedicated key in a workspace restricted to native search"
          : `Missing ${key}`,
    };
  if (target.model.includes(":online"))
    return { available: false, reason: "Use explicit search configuration instead of :online" };
  if (sonar(target) && target.search.mode !== "native")
    return { available: false, reason: "Sonar intrinsically searches; select native search" };
  if (searchEnabled(target) && !str(target.provider_options?.provider)?.trim())
    return {
      available: false,
      reason: "Search targets must pin provider_options.provider to an endpoint tag",
    };
  if (
    target.search.mode === "server" &&
    !["exa", "perplexity", "parallel", "firecrawl"].includes(target.search.engine)
  )
    return { available: false, reason: "Unsupported OpenRouter server search engine" };
  return { available: true };
}
async function endpoint(
  input: ProviderInput,
  context: ProviderContext,
  key: string,
): Promise<Endpoint | null> {
  if (!searchEnabled(input.target)) return null;
  const tag = str(input.target.provider_options?.provider) ?? "";
  try {
    const path = input.target.model.split("/").map(encodeURIComponent).join("/");
    const response = await context.fetch(`${root}/models/${path}/endpoints`, {
      headers: { authorization: `Bearer ${key}` },
      signal: input.signal,
    });
    if (!response.ok) throw new Error();
    const endpoints = records(obj(obj(await response.json()).data).endpoints);
    const selected = endpoints.find((value) => value.tag === tag);
    if (!selected || !str(selected.provider_name)) throw new Error();
    const native = obj(selected.native_tools)["openrouter:web_search"];
    if (
      input.target.search.mode === "native" &&
      !native &&
      !(sonar(input.target) && tag === "perplexity")
    )
      throw new Error();
    return { tag, providerName: String(selected.provider_name) };
  } catch {
    throw new ResearchError(
      "provider_not_dispatched",
      "Pinned endpoint does not advertise the required search capability",
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
  const raw = obj(result.raw_response);
  const responses = Array.isArray(raw.responses) ? records(raw.responses) : [raw];
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
async function verify(
  result: ProviderResult,
  input: ProviderInput,
  context: ProviderContext,
  key: string,
  selected: Endpoint | null,
): Promise<ProviderResult> {
  if (!searchEnabled(input.target)) return result;
  const items = await generationMetadata(result, context, key, input.signal);
  result.raw_response = { generation: result.raw_response, generation_metadata: items };
  const costs = items.map((item) => num(item?.total_cost));
  if (costs.every((cost) => cost !== null))
    result.usage.reported_cost_usd = costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
  const expectedEngine =
    input.target.search.mode === "server" ? input.target.search.engine : "native";
  const engines = [...new Set(items.map((item) => str(item?.web_search_engine) ?? null))];
  result.search_activity.engine = engines.length === 1 ? (engines[0] ?? null) : null;
  const providers = [...new Set(items.map((item) => str(item?.provider_name) ?? null))];
  result.serving_provider = providers.length === 1 ? (providers[0] ?? null) : null;
  const proved =
    items.length > 0 &&
    items.every(
      (item) =>
        item?.model === input.target.model &&
        item?.provider_name === selected?.providerName &&
        item?.web_search_engine === expectedEngine,
    );
  if ((result.usage.search_requests ?? 0) <= 0 || !proved)
    throw new ProviderResponseError(
      "search_proof_failed",
      "Search execution, engine, model or serving provider could not be verified",
      result,
    );
  result.search_activity.observed = "executed";
  return result;
}
export function createOpenRouterProvider(options: RouterOptions = {}): ModelProvider {
  return {
    availability: (target, context) => availability(options, target, context),
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
