import { z } from "zod";
import {
  ResearchError,
  type RunEstimate,
  type RunInput,
  runInputSchema,
  type Target,
  targetSchema,
} from "./contracts.js";

// Catalog snapshot: 2026-10-17. Estimates are not provider billing guarantees.
const defaults = [
  {
    id: "openai-native",
    transport: "openai",
    model: "gpt-6-luna",
    search: { mode: "native" },
    pricing: { input_per_million: 0.1, output_per_million: 0.5, search_per_request: 0.01 },
  },
  {
    id: "anthropic-native",
    transport: "anthropic",
    model: "claude-haiku-5-5",
    search: { mode: "native" },
    pricing: { input_per_million: 0.1, output_per_million: 0.5, search_per_request: 0.01 },
  },
  {
    id: "vertex-native",
    transport: "vertex",
    model: "gemini-3.8-flash",
    location: "global",
    search: { mode: "native" },
    pricing: { input_per_million: 0.825, output_per_million: 4.125, search_per_request: 0.014 },
  },
  {
    id: "perplexity-native",
    transport: "perplexity",
    model: "perplexity/sonar",
    search: { mode: "native" },
    pricing: { input_per_million: 1, output_per_million: 1, search_per_request: 0.005 },
  },
  {
    id: "router-plain",
    transport: "openrouter",
    model: "openai/gpt-6-luna",
    search: { mode: "off" },
    pricing: { input_per_million: 0.1, output_per_million: 0.5 },
  },
  {
    id: "openai-exa",
    transport: "openai",
    model: "gpt-6-luna",
    search: { mode: "controlled", engine: "exa" },
    pricing: { input_per_million: 0.1, output_per_million: 0.5 },
  },
  {
    id: "router-exa",
    transport: "openrouter",
    model: "openai/gpt-6-luna",
    search: { mode: "controlled", engine: "exa" },
    pricing: { input_per_million: 0.1, output_per_million: 0.5 },
  },
];
export const EXA_ESTIMATED_COST_PER_QUERY = 0.02;
export const EXA_SEARCH_ESTIMATE_USD = EXA_ESTIMATED_COST_PER_QUERY;
export function loadTargets(
  env: Record<string, string | undefined>,
  configuredTargets?: unknown,
): Target[] {
  const value = configuredTargets ?? (env.TARGETS_JSON ? JSON.parse(env.TARGETS_JSON) : defaults);
  const targets = z.array(targetSchema).min(1).max(100).parse(value);
  if (new Set(targets.map((t) => t.id)).size !== targets.length)
    throw new ResearchError("invalid_targets", "Target IDs must be unique");
  return targets;
}
export function vertexCredentials(env: Record<string, string | undefined>): {
  credentials: Record<string, unknown>;
  project: string;
} {
  const encoded = env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!encoded)
    throw new ResearchError(
      "missing_credentials",
      "Vertex service-account credentials are required",
    );
  try {
    const value = JSON.parse(
      encoded.startsWith("{") ? encoded : Buffer.from(encoded, "base64").toString("utf8"),
    );
    if (
      typeof value.client_email !== "string" ||
      typeof value.private_key !== "string" ||
      typeof value.project_id !== "string"
    )
      throw new Error();
    return { credentials: value, project: env.GOOGLE_VERTEX_PROJECT ?? value.project_id };
  } catch {
    throw new ResearchError(
      "invalid_credentials",
      "Vertex credentials must be service-account JSON or base64 JSON; load file credentials explicitly before execution",
    );
  }
}
export function targetAvailability(
  target: Target,
  env: Record<string, string | undefined>,
): { available: boolean; reason?: string } {
  if (target.transport === "openrouter" && target.model.includes(":online")) {
    return {
      available: false,
      reason:
        "OpenRouter :online implicitly enables deprecated search; configure explicit native or controlled search",
    };
  }
  const key = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    perplexity: "PERPLEXITY_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    vertex: "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
  }[target.transport];
  if (target.transport === "vertex") {
    try {
      vertexCredentials(env);
    } catch (e) {
      return {
        available: false,
        reason: e instanceof Error ? e.message : "Invalid Vertex credentials",
      };
    }
  } else if (!env[key]?.trim()) return { available: false, reason: `Missing ${key}` };
  if (target.search.mode === "controlled" && !env.EXA_API_KEY?.trim())
    return { available: false, reason: "Missing EXA_API_KEY" };
  if (
    target.transport === "perplexity" &&
    target.model.startsWith("perplexity/") &&
    target.search.mode !== "native"
  )
    return {
      available: false,
      reason:
        "Perplexity grounded models require native search; choose a non-search model for controlled/off modes",
    };
  return { available: true };
}
function observationEstimate(text: string, target: Target): number | null {
  if (!target.pricing) return null;
  const context =
    target.search.mode === "controlled"
      ? target.search.max_characters
      : target.search.mode === "native"
        ? 12_000
        : 0;
  // Conservative character count heuristic; native tool loops remain provider-controlled.
  const inputTokens = text.length + context + 1000;
  const searchCost =
    target.search.mode === "native"
      ? target.search.max_uses * target.pricing.search_per_request
      : 0;
  return (
    (inputTokens * target.pricing.input_per_million +
      target.max_output_tokens * target.pricing.output_per_million) /
      1e6 +
    searchCost
  );
}
export function estimateRun(raw: RunInput, targets: Target[]): RunEstimate {
  const input = runInputSchema.parse(raw);
  const selected = input.targets.map((id) => {
    const target = targets.find((t) => t.id === id);
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
  const options = new Set(
    selected.filter((t) => t.search.mode === "controlled").map((t) => JSON.stringify(t.search)),
  );
  const retrieval =
    input.prompts.reduce((sum, p) => sum + (p.queries?.length ?? 1) * EXA_SEARCH_ESTIMATE_USD, 0) *
    input.repetitions *
    options.size;
  const unpriced = selected.filter((t) => !t.pricing).map((t) => t.id);
  const total = observations.reduce((sum, o) => sum + (o.estimated_cost_usd ?? 0), 0);
  return {
    total_observations: observations.length,
    estimated_cost_usd: unpriced.length ? null : total + retrieval,
    retrieval_estimated_cost_usd: retrieval,
    unpriced_targets: unpriced,
    observations,
  };
}
