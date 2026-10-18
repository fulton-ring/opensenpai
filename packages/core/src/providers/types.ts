import type { ProviderInput, ProviderResult, RetrievalBundle, Target } from "../contracts.js";

export type ProviderEnvironment = Record<string, string | undefined>;
export interface ProviderContext {
  env: ProviderEnvironment;
  fetch: typeof globalThis.fetch;
}
export interface Availability {
  available: boolean;
  reason?: string;
}
export interface ModelProvider {
  availability(target: Target, context: ProviderContext): Availability;
  execute(input: ProviderInput, context: ProviderContext): Promise<ProviderResult>;
}
export interface RetrievalInput {
  id: string;
  engine: string;
  queries: string[];
  max_results: number;
  max_characters: number;
  options?: Record<string, unknown>;
  signal: AbortSignal;
}
export interface RetrievalProvider {
  availability(context: ProviderContext): Availability;
  estimate(
    input: Pick<RetrievalInput, "queries" | "max_results" | "max_characters" | "options">,
  ): number;
  retrieve(input: RetrievalInput, context: ProviderContext): Promise<RetrievalBundle>;
}
export interface ProviderRegistry {
  models: Readonly<Record<string, ModelProvider>>;
  retrievals: Readonly<Record<string, RetrievalProvider>>;
}
export interface ProviderOptions {
  fetch?: typeof globalThis.fetch;
  providers?: ProviderRegistry;
}
