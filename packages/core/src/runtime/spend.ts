import {
  type Observation,
  type ObservationStatus,
  ResearchError,
  type RetrievalBundle,
  type SpendAuthorization,
  type Usage,
} from "../contracts.js";
import type { ProviderRegistry } from "../providers/types.js";
import { retrievalEstimate } from "../targets.js";
import type { RuntimeOptions } from "./types.js";
/** Build a shared-retrieval spend request using the configured adapter estimate. */
export function retrievalAuthorization(
  observation: Observation,
  id: string,
  providers?: ProviderRegistry,
): SpendAuthorization {
  return {
    workspace_id: observation.workspace_id,
    run_id: observation.run_id,
    observation_id: observation.id,
    attempt_id: id,
    operation: "retrieval",
    estimated_cost_usd: retrievalEstimate(
      observation.target,
      observation.prompt.queries ?? [observation.prompt.text],
      providers,
    ),
  };
}

/** Represent retrieval settlement, or known zero usage when no request was dispatched. */
export function retrievalUsage(bundle?: RetrievalBundle): Usage {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_tokens: null,
    search_requests: bundle?.queries.length ?? 0,
    reported_cost_usd: bundle ? bundle.reported_cost_usd : 0,
    estimated_cost_usd: bundle?.estimated_cost_usd ?? 0,
    raw: {},
  };
}

/** Return explicit zero usage for an operation confirmed never to have been dispatched. */
export function undispatchedUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    search_requests: 0,
    reported_cost_usd: 0,
    estimated_cost_usd: 0,
    raw: {},
  };
}

/** Run the host spend gate and convert unexpected failures into a safe denial. */
export async function authorizeSpend(
  options: RuntimeOptions,
  attempt: SpendAuthorization,
): Promise<void> {
  try {
    await options.hooks?.authorize?.(attempt);
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError("authorization_denied", "Spend authorization was denied");
  }
}

/** Report background failures without allowing a host callback to break settlement. */
export function reportError(options: RuntimeOptions, error: unknown): void {
  try {
    options.onError?.(error);
  } catch {
    return;
  }
}

/** Notify the host of settlement while retaining runtime progress if reporting fails. */
export async function settleSpend(
  options: RuntimeOptions,
  attempt: SpendAuthorization,
  outcome: ObservationStatus,
  usage: Usage | null,
): Promise<void> {
  try {
    await options.hooks?.settled?.(attempt, outcome, usage);
  } catch (error) {
    reportError(options, error);
  }
}
