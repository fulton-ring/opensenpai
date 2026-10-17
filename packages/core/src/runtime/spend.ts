import {
  type Observation,
  type ObservationStatus,
  ResearchError,
  type RetrievalBundle,
  type SpendAuthorization,
  type Usage,
} from "../contracts.js";
import { EXA_ESTIMATED_COST_PER_QUERY } from "../targets.js";
import type { RuntimeOptions } from "./types.js";
export function retrievalAuthorization(observation: Observation, id: string): SpendAuthorization {
  return {
    workspace_id: observation.workspace_id,
    run_id: observation.run_id,
    observation_id: observation.id,
    attempt_id: id,
    operation: "retrieval",
    estimated_cost_usd: (observation.prompt.queries?.length ?? 1) * EXA_ESTIMATED_COST_PER_QUERY,
  };
}
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
export function reportError(options: RuntimeOptions, error: unknown): void {
  try {
    options.onError?.(error);
  } catch {
    return;
  }
}
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
