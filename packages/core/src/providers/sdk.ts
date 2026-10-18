import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, type ToolSet } from "ai";
import {
  type ProviderInput,
  type ProviderResult,
  ResearchError,
  type Target,
} from "../contracts.js";
import { type Json, obj, source } from "./normalize.js";
import { validateCapturedFailure, validateOutcome } from "./outcomes.js";
import type { Availability, ModelProvider, ProviderContext } from "./types.js";
export interface SdkModel {
  model: LanguageModel;
  tools?: ToolSet;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
}
export interface SdkProviderOptions {
  apiKeyEnv?: string;
  resolveTarget?: ModelProvider["resolveTarget"];
  listModels?: ModelProvider["listModels"];
  createModel(input: ProviderInput, context: ProviderContext): SdkModel | Promise<SdkModel>;
  availability?(target: Target, context: ProviderContext): Availability;
  verify?(
    result: ProviderResult,
    input: ProviderInput,
    context: ProviderContext,
  ): Promise<ProviderResult>;
}
function availability(
  options: SdkProviderOptions,
  target: Target,
  context: ProviderContext,
): Availability {
  if (options.apiKeyEnv && !context.env[options.apiKeyEnv]?.trim())
    return { available: false, reason: `Missing ${options.apiKeyEnv}` };
  if (["native", "server"].includes(target.search.mode) && !options.verify)
    return {
      available: false,
      reason: "Search-enabled SDK adapters require explicit search verification",
    };
  return options.availability?.(target, context) ?? { available: true };
}
function captureResponses(fetcher: typeof fetch) {
  const responses: Json[] = [],
    pending: Promise<void>[] = [];
  let status: number | null = null;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const response = await fetcher(url, init);
    status = response.status;
    const index = responses.length;
    responses.push({});
    pending.push(
      response
        .clone()
        .json()
        .then(
          (value) => {
            responses[index] = obj(value);
          },
          () => {},
        ),
    );
    return response;
  };
  return { fetch, responses, pending, status: () => status };
}
function safeFailure(error: unknown, status: number | null): ResearchError {
  if (error instanceof ResearchError) return error;
  const code = status !== null && status >= 400 ? status : null;
  return new ResearchError(
    code ? `provider_http_${code}` : "provider_error",
    code ? `Provider rejected request (HTTP ${code})` : "Provider generation failed",
    code === 429 || (code !== null && code >= 500),
  );
}
async function generate(
  input: ProviderInput,
  context: ProviderContext,
  options: SdkProviderOptions,
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.target.timeout_ms)]);
  const captured = captureResponses(context.fetch);
  // Model creation may perform read-only preflight. Only generation responses enter usage accounting.
  const configured = await options.createModel(
    { ...input, signal },
    { ...context, fetch: captured.fetch },
  );
  try {
    const result = await generateText({
      ...configured,
      system: `Answer in locale ${input.locale}. Cite sources when available.${input.target.search.mode === "controlled" ? " Use only the supplied source context; do not perform web searches." : ""}`,
      prompt: input.retrieval
        ? `${input.prompt.text}\n\nSOURCE CONTEXT\n${input.retrieval.context}`
        : input.prompt.text,
      maxOutputTokens: input.target.max_output_tokens,
      temperature: input.target.temperature,
      maxRetries: 0,
      abortSignal: signal,
    });
    await Promise.all(captured.pending);
    const normalized = validateOutcome(
      input,
      captured.responses.at(-1) ?? {
        id: result.response.id,
        model: result.response.modelId,
        body: result.response.body,
      },
      result.text,
      result.finishReason,
      {
        responses: captured.responses,
        sdk_usage: result.totalUsage,
        sdk_sources: result.sources.map(source).filter((s) => s !== null),
      },
    );
    return options.verify ? options.verify(normalized, { ...input, signal }, context) : normalized;
  } catch (error) {
    await Promise.all(captured.pending);
    if (error instanceof ResearchError) throw error;
    for (const raw of captured.responses)
      validateCapturedFailure(input, raw, { responses: captured.responses });
    signal.throwIfAborted();
    throw safeFailure(error, captured.status());
  }
}
export function createSdkProvider(options: SdkProviderOptions): ModelProvider {
  return {
    availability: (target, context) => availability(options, target, context),
    resolveTarget: options.resolveTarget,
    listModels: options.listModels,
    execute: (input, context) => generate(input, context, options),
  };
}
export function createOpenAICompatibleProvider(options: {
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  pricing?:
    | Target["pricing"]
    | ((
        target: Target,
        context: ProviderContext,
      ) => Target["pricing"] | Promise<Target["pricing"]>);
  listModels?: ModelProvider["listModels"];
}): ModelProvider {
  return createSdkProvider({
    apiKeyEnv: options.apiKeyEnv,
    listModels: options.listModels,
    resolveTarget: async (target, context) => ({
      ...target,
      pricing:
        typeof options.pricing === "function"
          ? await options.pricing(target, context)
          : options.pricing,
    }),
    createModel: (input, context) => ({
      model: createOpenAICompatible({
        name: options.name,
        baseURL: options.baseURL,
        apiKey: context.env[options.apiKeyEnv],
        fetch: context.fetch,
      })(input.target.model),
    }),
  });
}
