import { type ProviderInput, ResearchError } from "../contracts.js";
import { createOpenRouterProvider } from "./openrouter.js";
import { exaProvider } from "./retrieval.js";
import type {
  ModelProvider,
  ProviderEnvironment,
  ProviderOptions,
  ProviderRegistry,
  RetrievalInput,
  RetrievalProvider,
} from "./types.js";

export const EXA_ESTIMATED_COST_PER_QUERY = 0.02;
export { createOpenRouterProvider } from "./openrouter.js";
export { ProviderResponseError } from "./outcomes.js";
export { exaProvider } from "./retrieval.js";
export type { SdkModel, SdkProviderOptions } from "./sdk.js";
export { createOpenAICompatibleProvider, createSdkProvider } from "./sdk.js";
export type * from "./types.js";
export function createProviderRegistry(
  config: {
    models?: Record<string, ModelProvider>;
    retrievals?: Record<string, RetrievalProvider>;
  } = {},
): ProviderRegistry {
  return {
    models: Object.freeze({ ...config.models }),
    retrievals: Object.freeze({ ...config.retrievals }),
  };
}
export const defaultProviders = createProviderRegistry({
  models: { openrouter: createOpenRouterProvider() },
  retrievals: { exa: exaProvider },
});
export async function executeProvider(
  input: ProviderInput,
  env: ProviderEnvironment,
  options: ProviderOptions = {},
) {
  input.signal.throwIfAborted();
  if (input.target.search.mode === "controlled" && !input.retrieval)
    throw new ResearchError(
      "missing_retrieval",
      "Controlled generation requires a completed retrieval bundle",
    );
  const models = (options.providers ?? defaultProviders).models;
  const provider = Object.hasOwn(models, input.target.transport)
    ? models[input.target.transport]
    : undefined;
  const context = { env, fetch: options.fetch ?? globalThis.fetch };
  const availability = provider?.availability(input.target, context);
  if (!provider || !availability?.available)
    throw new ResearchError(
      "provider_not_dispatched",
      availability?.reason ?? `Unknown model provider: ${input.target.transport}`,
    );
  return provider.execute(input, context);
}
export async function retrieveSearch(
  input: RetrievalInput,
  env: ProviderEnvironment,
  options: ProviderOptions = {},
) {
  input.signal.throwIfAborted();
  const retrievals = (options.providers ?? defaultProviders).retrievals;
  const provider = Object.hasOwn(retrievals, input.engine) ? retrievals[input.engine] : undefined;
  const context = { env, fetch: options.fetch ?? globalThis.fetch };
  const availability = provider?.availability(context);
  if (!provider || !availability?.available)
    throw new ResearchError(
      "provider_not_dispatched",
      availability?.reason ?? `Unknown retrieval provider: ${input.engine}`,
    );
  return provider.retrieve(input, context);
}
export async function retrieveExa(
  input: Omit<RetrievalInput, "engine"> & { engine?: string },
  env: ProviderEnvironment,
  options: ProviderOptions = {},
) {
  return retrieveSearch({ ...input, engine: input.engine ?? "exa" }, env, options);
}
