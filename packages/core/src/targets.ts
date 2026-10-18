import { z } from "zod";
import {
  ResearchError,
  type RunEstimate,
  type RunInput,
  runInputSchema,
  type Target,
  targetSchema,
} from "./contracts.js";
import { defaultProviders } from "./providers/index.js";
import type { ProviderRegistry } from "./providers/types.js";

/** Optional preset catalog; agents can select models and search directly through MCP. */
export const defaultTargets: Target[] = [];

/** Load and validate operator presets from configuration or the environment. */
export function loadTargets(
  env: Record<string, string | undefined>,
  configuredTargets?: unknown,
): Target[] {
  const value =
    configuredTargets ?? (env.TARGETS_JSON ? JSON.parse(env.TARGETS_JSON) : defaultTargets);
  const targets = z.array(targetSchema).max(100).parse(value);
  if (new Set(targets.map((target) => target.id)).size !== targets.length)
    throw new ResearchError("invalid_targets", "Target IDs must be unique");
  return targets;
}

/** Check that installed model and retrieval adapters can serve the selected target. */
export function targetAvailability(
  target: Target,
  env: Record<string, string | undefined>,
  providers: ProviderRegistry = defaultProviders,
) {
  if (!Object.hasOwn(providers.models, target.transport))
    return { available: false, reason: `Unknown model adapter '${target.transport}'` };
  const model = providers.models[target.transport];
  if (!model) return { available: false, reason: "Model adapter unavailable" };
  const availability = model.availability(target, { env, fetch });
  if (!availability.available || target.search.mode !== "controlled") return availability;
  if (!Object.hasOwn(providers.retrievals, target.search.engine))
    return { available: false, reason: `Unknown retrieval adapter '${target.search.engine}'` };
  return (
    providers.retrievals[target.search.engine]?.availability({ env, fetch }) ?? { available: false }
  );
}

/** Obtain a finite, nonnegative reservation estimate from the selected retrieval adapter. */
export function retrievalEstimate(
  target: Target,
  queries: string[],
  providers: ProviderRegistry = defaultProviders,
): number {
  if (target.search.mode !== "controlled") return 0;
  const provider = Object.hasOwn(providers.retrievals, target.search.engine)
    ? providers.retrievals[target.search.engine]
    : undefined;
  if (!provider)
    throw new ResearchError(
      "unknown_retrieval_provider",
      `Unknown retrieval adapter '${target.search.engine}'`,
    );
  const estimate = provider.estimate({ queries, ...target.search });
  if (!Number.isFinite(estimate) || estimate < 0)
    throw new ResearchError(
      "invalid_retrieval_estimate",
      "Retrieval estimate must be finite and nonnegative",
    );
  return estimate;
}

function observationEstimate(text: string, target: Target): number | null {
  if (!target.pricing) return null;
  const search = target.search;
  const context =
    search.mode === "controlled" ? search.max_characters : search.mode === "off" ? 0 : 12_000;
  const inputTokens = text.length + context + 1_000;
  const searchCost =
    search.mode === "native" || search.mode === "server"
      ? search.max_uses * target.pricing.search_per_request
      : 0;
  return (
    (inputTokens * target.pricing.input_per_million +
      target.max_output_tokens * target.pricing.output_per_million) /
      1e6 +
    searchCost
  );
}

/** Estimate model work and deduplicated shared retrieval for a validated batch. */
export function estimateRun(
  raw: RunInput,
  targets: Target[],
  providers: ProviderRegistry = defaultProviders,
): RunEstimate {
  const input = runInputSchema.parse(raw);
  const selected = input.targets.map((selection) => {
    const id = typeof selection === "string" ? selection : selection.id;
    const target = targets.find((item) => item.id === id);
    if (!target) throw new ResearchError("unknown_target", `Unknown target: ${id}`);
    return target;
  });
  const observations = input.prompts.flatMap((prompt) =>
    Array.from({ length: input.repetitions }, (_, repetition) =>
      selected.map((target) => ({
        prompt_id: prompt.id,
        target_id: target.id,
        repetition,
        estimated_cost_usd: observationEstimate(prompt.text, target),
      })),
    ).flat(),
  );
  const shared = new Map(
    selected
      .filter((target) => target.search.mode === "controlled")
      .map((target) => [JSON.stringify(target.search), target]),
  );
  const retrieval =
    input.prompts.reduce(
      (sum, prompt) =>
        sum +
        [...shared.values()].reduce(
          (cost, target) =>
            cost + retrievalEstimate(target, prompt.queries ?? [prompt.text], providers),
          0,
        ),
      0,
    ) * input.repetitions;
  const unpriced = selected.filter((target) => !target.pricing).map((target) => target.id);
  const total = observations.reduce((sum, item) => sum + (item.estimated_cost_usd ?? 0), 0);
  return {
    total_observations: observations.length,
    estimated_cost_usd: unpriced.length ? null : total + retrieval,
    retrieval_estimated_cost_usd: retrieval,
    unpriced_targets: unpriced,
    observations,
  };
}
