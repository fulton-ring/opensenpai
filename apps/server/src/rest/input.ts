import { z } from "zod";

const integer = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int());
/** Bounded catalog filters accepted by the research targets resource. */
export const discoveryInput = z.strictObject({
  provider: z.string().min(1).max(80).optional(),
  model_query: z.string().min(1).max(200).optional(),
  limit: integer.pipe(z.number().min(1).max(50)).optional(),
});
/** Stable workspace run pagination accepted by the research collection. */
export const listInput = z.strictObject({
  project: z.string().max(120).optional(),
  limit: integer.pipe(z.number().min(1).max(100)).optional(),
  before: z.string().max(100).optional(),
  cursor: z.string().min(1).max(1000).optional(),
});
/** Bounded long-poll query for reading one durable run. */
export const runQuery = z.strictObject({
  wait_ms: integer.pipe(z.number().min(0).max(10_000)).default(0),
});
/** Observation filters and ordinal pagination, with explicit raw-payload opt-in. */
export const resultsInput = z.strictObject({
  target_id: z.string().min(1).max(80).optional(),
  prompt_id: z.string().min(1).max(80).optional(),
  status: z
    .enum(["pending", "running", "succeeded", "failed", "cancelled", "unknown_outcome"])
    .optional(),
  cursor: integer.pipe(z.number().nonnegative()).optional(),
  limit: integer.pipe(z.number().min(1).max(100)).optional(),
  include_raw: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
/** Cancellation is the only caller-writable run field. */
export const cancelInput = z.strictObject({ cancel_requested: z.literal(true) });
/** Durable run identifiers may be supplied as a single encoded path segment. */
export const runId = z.string().min(1).max(160);
