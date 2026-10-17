import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type LanguageModel, type ToolSet } from "ai";
import {
  type ProviderInput,
  type ProviderResult,
  ResearchError,
  type RetrievalBundle,
  type Source,
} from "../contracts.js";
import { EXA_SEARCH_ESTIMATE_USD, targetAvailability, vertexCredentials } from "../targets.js";
import { type Json, num, obj, records, source, str } from "./normalize.js";

type Env = Record<string, string | undefined>;
type Options = { fetch?: typeof fetch };

import { validateCapturedFailure, validateOutcome } from "./outcomes.js";

export { ProviderResponseError } from "./outcomes.js";

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
function nativeOpenAI(input: ProviderInput, env: Env, fetch: typeof globalThis.fetch) {
  const provider = createOpenAI({ apiKey: env.OPENAI_API_KEY ?? "", fetch });
  return {
    model: provider.responses(input.target.model),
    tools:
      input.target.search.mode === "native"
        ? { web_search: provider.tools.webSearch({ searchContextSize: "low" }) }
        : undefined,
  };
}
function nativeAnthropic(input: ProviderInput, env: Env, fetch: typeof globalThis.fetch) {
  const provider = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "", fetch });
  return {
    model: provider(input.target.model),
    tools:
      input.target.search.mode === "native"
        ? {
            web_search: provider.tools.webSearch_20250305({
              maxUses: input.target.search.max_uses,
            }),
          }
        : undefined,
  };
}
function nativeVertex(input: ProviderInput, env: Env, fetch: typeof globalThis.fetch) {
  const credentials = vertexCredentials(env);
  const provider = createVertex({
    apiKey: "", // Explicitly disable ambient express-mode API-key authentication.
    project: credentials.project,
    location: input.target.location ?? env.GOOGLE_VERTEX_LOCATION ?? "global",
    googleAuthOptions: { credentials: credentials.credentials },
    fetch,
  });
  return {
    model: provider(input.target.model),
    tools:
      input.target.search.mode === "native"
        ? { google_search: provider.tools.googleSearch({}) }
        : undefined,
  };
}
function nativeRouter(input: ProviderInput, env: Env, fetch: typeof globalThis.fetch) {
  const search = input.target.search;
  const provider = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY ?? "",
    fetch,
    extraBody: {
      provider: { allow_fallbacks: false },
      ...(input.target.reasoning_effort
        ? { reasoning: { effort: input.target.reasoning_effort } }
        : {}),
      ...(search.mode === "native"
        ? {
            tools: [
              {
                type: "openrouter:web_search",
                parameters: { engine: "native", max_uses: search.max_uses },
              },
            ],
            max_tool_calls: search.max_uses,
          }
        : {}),
    },
  });
  return { model: provider.chat(input.target.model), tools: undefined };
}
const native = {
  openai: nativeOpenAI,
  anthropic: nativeAnthropic,
  vertex: nativeVertex,
  openrouter: nativeRouter,
};
async function perplexity(
  input: ProviderInput,
  env: Env,
  fetcher: typeof fetch,
  signal: AbortSignal,
  instructions: string,
  prompt: string,
): Promise<ProviderResult> {
  // The installed Mastra Perplexity integration targets chat/completions, not Agent API.
  const { target } = input;
  const raw = await http(
    fetcher,
    "https://api.perplexity.ai/v1/agent",
    {
      model: target.model,
      input: prompt,
      instructions,
      max_output_tokens: target.max_output_tokens,
      ...(target.temperature === undefined ? {} : { temperature: target.temperature }),
      tools: target.search.mode === "native" ? [{ type: "web_search" }] : [],
      max_steps: target.search.mode === "native" ? target.search.max_uses : 1,
    },
    env.PERPLEXITY_API_KEY ?? "",
    signal,
  );
  const answer = records(raw.output)
    .flatMap((o) => records(o.content))
    .filter((c) => c.type === "output_text")
    .map((c) => str(c.text) ?? "")
    .join("");
  return validateOutcome(input, raw, answer, str(raw.status) ?? null);
}
function checkInput(input: ProviderInput, env: Env) {
  input.signal.throwIfAborted();
  if (input.target.search.mode === "controlled" && !input.retrieval)
    throw new ResearchError(
      "missing_retrieval",
      "Controlled generation requires a completed retrieval bundle",
    );
  const availability = targetAvailability(input.target, env);
  if (
    !availability.available &&
    !(input.retrieval && availability.reason === "Missing EXA_API_KEY")
  )
    throw new ResearchError(
      availability.reason?.startsWith("Missing")
        ? "missing_credentials"
        : "unsupported_configuration",
      availability.reason ?? "Target unavailable",
    );
}
function safeError(error: unknown, responseStatus: number | null): ResearchError {
  if (error instanceof ResearchError) return error;
  const status = responseStatus !== null && responseStatus >= 400 ? responseStatus : null;
  return new ResearchError(
    status ? `provider_http_${status}` : "provider_error",
    status ? `Provider rejected request (HTTP ${status})` : "Provider generation failed",
    status === 429 || (status !== null && status >= 500),
  );
}
export async function executeProvider(
  input: ProviderInput,
  env: Env,
  options: Options = {},
): Promise<ProviderResult> {
  checkInput(input, env);
  const { target } = input;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(target.timeout_ms)]);
  const fetcher = options.fetch ?? fetch;
  const instructions = `Answer in locale ${input.locale}. Cite sources when available.${target.search.mode === "controlled" ? " Use only the supplied source context; do not perform web searches." : ""}`;
  const prompt = input.retrieval
    ? `${input.prompt.text}\n\nSOURCE CONTEXT\n${input.retrieval.context}`
    : input.prompt.text;
  if (target.transport === "perplexity")
    return perplexity(input, env, fetcher, signal, instructions, prompt);
  const responses: Json[] = [];
  const pending: Promise<void>[] = [];
  let responseStatus: number | null = null;
  const capture: typeof fetch = async (u, init) => {
    const response = await fetcher(u, init);
    responseStatus = response.status;
    const slot = responses.length;
    responses.push({});
    pending.push(
      response
        .clone()
        .json()
        .then(
          (v) => {
            responses[slot] = obj(v);
          },
          () => {},
        ),
    );
    return response;
  };
  const { model, tools }: { model: LanguageModel; tools: ToolSet | undefined } = native[
    target.transport
  ](input, env, capture);
  try {
    const result = await generateText({
      model,
      system: instructions,
      prompt,
      tools,
      maxOutputTokens: target.max_output_tokens,
      temperature: target.temperature,
      maxRetries: 0,
      providerOptions:
        target.transport === "openai" && target.reasoning_effort
          ? { openai: { reasoningEffort: target.reasoning_effort } }
          : undefined,
      abortSignal: signal,
    });
    await Promise.all(pending);
    return validateOutcome(input, responses.at(-1) ?? {}, result.text, result.finishReason, {
      responses,
      sdk_usage: result.usage,
    });
  } catch (error) {
    await Promise.all(pending);
    if (error instanceof ResearchError) throw error;
    for (const raw of responses) validateCapturedFailure(input, raw, { responses });
    signal.throwIfAborted();
    throw safeError(error, responseStatus);
  }
}
interface RetrievalInput {
  id: string;
  queries: string[];
  max_results: number;
  max_characters: number;
  signal: AbortSignal;
}
function checkRetrieval(input: RetrievalInput, env: Env) {
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
export async function retrieveExa(
  input: RetrievalInput,
  env: Env,
  options: Options = {},
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

export { EXA_ESTIMATED_COST_PER_QUERY } from "../targets.js";
