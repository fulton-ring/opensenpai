import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, type ToolSet } from "ai";
import {
  type ProviderInput,
  type ProviderResult,
  ResearchError,
  type Target,
} from "../contracts.js";
import { type Json, normalize, obj, source } from "./normalize.js";
import { ProviderResponseError, validateCapturedFailure, validateOutcome } from "./outcomes.js";
import type { Availability, ModelProvider, ProviderContext } from "./types.js";

/** SDK-compatible model and optional tool settings created for one research operation. */
export interface SdkModel {
  model: LanguageModel;
  tools?: ToolSet;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
}

/** Operator hooks for model construction, catalog discovery, pricing and result verification. */
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
  let requests = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests++;
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
  return { fetch, responses, pending, status: () => status, requests: () => requests };
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

async function configureModel(
  input: ProviderInput,
  context: ProviderContext,
  options: SdkProviderOptions,
  captured: ReturnType<typeof captureResponses>,
): Promise<SdkModel> {
  try {
    return await options.createModel(input, { ...context, fetch: captured.fetch });
  } catch (error) {
    await Promise.all(captured.pending);
    if (error instanceof ProviderResponseError) throw error;
    if (captured.requests() === 0)
      throw new ResearchError(
        "provider_not_dispatched",
        "Provider model setup failed before dispatch",
      );
    const result = normalize(input, captured.responses.at(-1) ?? {}, "", null, {
      responses: captured.responses,
    });
    throw new ProviderResponseError(
      "provider_setup_failed",
      "Provider model setup failed after HTTP activity",
      result,
    );
  }
}

async function verifyResult(
  result: ProviderResult,
  input: ProviderInput,
  context: ProviderContext,
  options: SdkProviderOptions,
) {
  if (!options.verify) return result;
  try {
    return await options.verify(result, input, context);
  } catch (error) {
    if (error instanceof ProviderResponseError) throw error;
    throw new ProviderResponseError(
      "verification_failed",
      "Provider result verification failed",
      result,
    );
  }
}

async function generate(
  input: ProviderInput,
  context: ProviderContext,
  options: SdkProviderOptions,
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.target.timeout_ms)]);
  const captured = captureResponses(context.fetch);
  // Model creation may perform read-only preflight. Only generation responses enter usage accounting.
  const configured = await configureModel({ ...input, signal }, context, options, captured);
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
      include: { responseBody: true },
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
        sdk_metadata: {
          provider_metadata: result.providerMetadata,
          response: result.response,
          usage: result.totalUsage,
        },
        sdk_sources: result.sources.map(source).filter((s) => s !== null),
      },
    );
    return await verifyResult(normalized, { ...input, signal }, context, options);
  } catch (error) {
    await Promise.all(captured.pending);
    if (error instanceof ResearchError) throw error;
    for (const raw of captured.responses)
      validateCapturedFailure(input, raw, { responses: captured.responses });
    signal.throwIfAborted();
    throw safeFailure(error, captured.status());
  }
}

/** Wraps a Mastra-compatible SDK model with bounded generation, evidence capture and settlement-safe errors. */
export function createSdkProvider(options: SdkProviderOptions): ModelProvider {
  return {
    availability: (target, context) => availability(options, target, context),
    resolveTarget: options.resolveTarget,
    listModels: options.listModels,
    execute: (input, context) => generate(input, context, options),
  };
}

/** Creates a chat-completions gateway adapter with operator-owned credentials and optional pricing. */
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
