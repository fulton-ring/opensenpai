import { z } from "zod";

const adapterId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const pluginOptions = z.record(z.string(), z.json());

/** Validate separately selected search behavior and bound retrieval or native search work. */
export const searchSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }).strict(),
  z
    .object({ mode: z.literal("native"), max_uses: z.number().int().min(1).max(3).default(1) })
    .strict(),
  z
    .object({
      mode: z.literal("server"),
      engine: adapterId,
      max_uses: z.number().int().min(1).max(3).default(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("controlled"),
      engine: adapterId,
      max_results: z.number().int().min(1).max(10).default(3),
      max_characters: z.number().int().min(100).max(30_000).default(12_000),
      options: pluginOptions.optional(),
    })
    .strict(),
]);

/** Validate operator-supplied rates used to reserve estimated spend before dispatch. */
export const pricingSchema = z
  .object({
    input_per_million: z.number().nonnegative(),
    output_per_million: z.number().nonnegative(),
    search_per_request: z.number().nonnegative().default(0),
  })
  .strict();

/** Validate a resolved model adapter, search configuration, and execution limits. */
export const targetSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    transport: adapterId,
    model: z.string().min(1).max(200),
    search: searchSchema,
    max_output_tokens: z.number().int().min(32).max(4096).default(512),
    timeout_ms: z.number().int().min(1_000).max(120_000).default(120_000),
    temperature: z.number().min(0).max(2).optional(),
    reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    location: z.string().max(80).optional(),
    pricing: pricingSchema.optional(),
    provider_options: pluginOptions.optional(),
  })
  .strict();

/** Validate a research prompt and optional queries for shared controlled retrieval. */
export const promptSchema = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().trim().min(1).max(8_000),
    queries: z.array(z.string().trim().min(1).max(500)).min(1).max(3).optional(),
  })
  .strict();

/** Validate agent-selected models and search without accepting operator-only pricing or credentials. */
export const inlineTargetSchema = targetSchema
  .omit({
    transport: true,
    pricing: true,
    provider_options: true,
    location: true,
  })
  .extend({
    provider: adapterId,
    serving_provider: z.string().min(1).max(200).optional(),
  })
  .strict();
/** Accept either a configured preset ID or an inline model and search selection. */
export const targetSelectionSchema = z.union([z.string().min(1).max(80), inlineTargetSchema]);

/** Validate bounded research batches and their workspace-scoped idempotency keys. */
export const runInputSchema = z
  .object({
    prompts: z.array(promptSchema).min(1).max(25),
    targets: z.array(targetSelectionSchema).min(1).max(10),
    repetitions: z.number().int().min(1).max(5).default(1),
    locale: z.string().min(2).max(40).default("en-US"),
    project: z.string().max(120).optional(),
    idempotency_key: z.string().min(1).max(160),
    max_estimated_cost_usd: z.number().positive().max(1_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.prompts.map((p) => p.id)).size !== value.prompts.length) {
      context.addIssue({ code: "custom", message: "Prompt IDs must be unique", path: ["prompts"] });
    }
    if (
      new Set(value.targets.map((target) => (typeof target === "string" ? target : target.id)))
        .size !== value.targets.length
    ) {
      context.addIssue({ code: "custom", message: "Target IDs must be unique", path: ["targets"] });
    }
    if (value.prompts.length * value.targets.length * value.repetitions > 100) {
      context.addIssue({ code: "custom", message: "A run supports at most 100 observations" });
    }
  });

/** Resolved execution configuration persisted with every observation for reproducibility. */
export type Target = z.infer<typeof targetSchema>;
/** Agent-selectable model and search settings resolved against installed adapters. */
export type InlineTarget = z.infer<typeof inlineTargetSchema>;
/** A named research question with optional explicit retrieval queries. */
export type Prompt = z.infer<typeof promptSchema>;
/** Validated batch request including repetitions, locale, and optional spend cap. */
export type RunInput = z.infer<typeof runInputSchema>;
/** Registry key selecting the adapter that executes a model request. */
export type Transport = Target["transport"];
/** Durable observation state; unknown outcomes retain reservations until reconciled. */
export type ObservationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown_outcome";
/** Aggregate lifecycle derived from observation states and cancellation requests. */
export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

/** Serializable failure information that preserves whether retrying is safe. */
export interface Failure {
  code: string;
  message: string;
  retryable: boolean;
}

/** Retrieved evidence, with optional provider metadata and full source text. */
export interface Source {
  url: string;
  title?: string;
  text?: string;
  metadata?: unknown;
}

/** An answer citation preserving provider locators and their coordinate units. */
export interface Citation {
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
  cited_text?: string;
  locator_units?: string;
  metadata?: unknown;
}

/** Normalized usage and cost evidence; null values mean the provider did not report them. */
export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  search_requests: number | null;
  reported_cost_usd: number | null;
  estimated_cost_usd: number | null;
  raw: unknown;
}

/** Normalized answer with provenance, observed search activity, and original provider evidence. */
export interface ProviderResult {
  answer: string;
  requested_model: string;
  model: string;
  serving_provider: string | null;
  response_id: string | null;
  finish_reason: string | null;
  sources: Source[];
  citations: Citation[];
  extracted_urls: string[];
  search_activity: {
    requested: Target["search"]["mode"];
    observed: "executed" | "not_observed" | "unknown";
    engine: string | null;
  };
  usage: Usage;
  raw_response: unknown;
  warnings: string[];
}

/** Shared search evidence persisted once and reused by compatible observations. */
export interface RetrievalBundle {
  id: string;
  queries: string[];
  sources: Source[];
  context: string;
  raw_response: unknown;
  estimated_cost_usd: number;
  reported_cost_usd: number | null;
  created_at: string;
}

/** Persisted prompt-target execution with durable ownership, lease, and result evidence. */
export interface Observation {
  id: string;
  workspace_id: string;
  run_id: string;
  ordinal: number;
  prompt: Prompt;
  target: Target;
  repetition: number;
  locale: string;
  status: ObservationStatus;
  attempt_id: string | null;
  owner: string | null;
  lease_until: string | null;
  dispatched_at: string | null;
  retrieval_id: string | null;
  estimated_cost_usd: number | null;
  result: ProviderResult | null;
  error: Failure | null;
  created_at: string;
  updated_at: string;
}

/** Workspace-scoped batch state with aggregate outcomes and settled or reserved spend. */
export interface RunRecord {
  id: string;
  workspace_id: string;
  input: RunInput;
  status: RunStatus;
  cancel_requested: boolean;
  total: number;
  counts: Record<ObservationStatus, number>;
  estimated_cost_usd: number | null;
  reported_cost_usd: number;
  reserved_cost_usd: number;
  created_at: string;
  updated_at: string;
}

/** Pre-dispatch cost estimate identifying targets without configured model pricing. */
export interface RunEstimate {
  total_observations: number;
  estimated_cost_usd: number | null;
  retrieval_estimated_cost_usd: number;
  unpriced_targets: string[];
  observations: {
    prompt_id: string;
    target_id: string;
    repetition: number;
    estimated_cost_usd: number | null;
  }[];
}

/** Filters and ordinal pagination for reading a run’s observation evidence. */
export interface ResultQuery {
  run_id: string;
  target_id?: string;
  prompt_id?: string;
  status?: ObservationStatus;
  cursor?: number;
  limit?: number;
  include_raw?: boolean;
}

/** Single model invocation with resolved settings, optional shared evidence, and cancellation. */
export interface ProviderInput {
  observation_id: string;
  prompt: Prompt;
  target: Target;
  locale: string;
  retrieval?: RetrievalBundle;
  signal: AbortSignal;
}

/** Identifies a paid operation and its estimated charge before dispatch. */
export interface SpendAuthorization {
  /** Omitted operations are model calls; retrieval uses its shared bundle ID as attempt_id. */
  operation?: "model" | "retrieval";
  workspace_id: string;
  run_id: string;
  observation_id: string;
  attempt_id: string;
  estimated_cost_usd: number | null;
}

/** Optional host callbacks for authorizing paid work and recording settlement evidence. */
export interface ExecutionHooks {
  authorize?: (attempt: SpendAuthorization) => Promise<void>;
  settled?: (
    attempt: SpendAuthorization,
    outcome: ObservationStatus,
    usage: Usage | null,
    revision?: number,
  ) => Promise<void>;
}

/** Durable shared-retrieval claim and its terminal evidence or uncertain outcome. */
export interface RetrievalRecord {
  id: string;
  status: "running" | "succeeded" | "failed" | "unknown_outcome";
  owner: string;
  lease_until: string;
  bundle: RetrievalBundle | null;
  error: Failure | null;
}

/** Domain error whose code and retry policy can cross process boundaries safely. */
export class ResearchError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = "ResearchError";
  }
}
