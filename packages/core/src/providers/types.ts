import type {
  ProviderInput,
  ProviderResult,
  RetrievalBundle,
  Target,
  Usage,
} from "../contracts.js";

/** Operator-owned credentials and settings supplied to registered adapters. */
export type ProviderEnvironment = Record<string, string | undefined>;
/** Request dependencies shared by SDK factories and custom protocol adapters. */
export interface ProviderContext {
  env: ProviderEnvironment;
  fetch: typeof globalThis.fetch;
}
/** Explain whether the current configuration can execute a particular provider choice. */
export interface Availability {
  available: boolean;
  reason?: string;
}
/** Register a model factory or protocol adapter without modifying research workflows. */
export interface ModelProvider {
  availability(target: Target, context: ProviderContext): Availability;
  /** Resolve operator-owned pricing/routing for a model selected through MCP. Never generates text. */
  resolveTarget?(target: Target, context: ProviderContext): Promise<Target>;
  /** Resolve retained billing evidence using read-only provider metadata; null means unresolved. */
  reconcileUsage?(
    target: Target,
    result: ProviderResult,
    context: ProviderContext,
  ): Promise<Usage | null>;
  listModels?(
    query: { query?: string; limit: number },
    context: ProviderContext,
  ): Promise<{ id: string; name?: string }[]>;
  execute(input: ProviderInput, context: ProviderContext): Promise<ProviderResult>;
}
/** A bounded, shared retrieval operation independent of model generation. */
export interface RetrievalInput {
  id: string;
  engine: string;
  queries: string[];
  max_results: number;
  max_characters: number;
  options?: Record<string, unknown>;
  signal: AbortSignal;
}
/** Supply retrieval execution and trusted cost estimates for reservations. */
export interface RetrievalProvider {
  availability(context: ProviderContext): Availability;
  estimate(
    input: Pick<RetrievalInput, "queries" | "max_results" | "max_characters" | "options">,
  ): number;
  retrieve(input: RetrievalInput, context: ProviderContext): Promise<RetrievalBundle>;
}
/** Operator-selected adapters addressable by stable identifiers in MCP experiments. */
export interface ProviderRegistry {
  models: Readonly<Record<string, ModelProvider>>;
  retrievals: Readonly<Record<string, RetrievalProvider>>;
}
/** Override registry and transport dependencies for library use and verification. */
export interface ProviderOptions {
  fetch?: typeof globalThis.fetch;
  providers?: ProviderRegistry;
}
