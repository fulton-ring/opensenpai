import {
  type ProviderInput,
  type ProviderResult,
  ResearchError,
  type RetrievalBundle,
} from "../contracts.js";
import { type Json, type NormalizationContext, normalize, obj, records, str } from "./normalize.js";

/** A terminal provider outcome whose usage and exact response remain available to settlement. */
export class ProviderResponseError extends ResearchError {
  constructor(
    code: string,
    message: string,
    public result: ProviderResult,
  ) {
    super(code, message);
    this.name = "ProviderResponseError";
  }
}

/** Partial retrieval evidence; unknown charges retain the full reservation despite completed-query costs. */
export class RetrievalResponseError extends ResearchError {
  constructor(
    code: string,
    message: string,
    public bundle: RetrievalBundle,
    public unknown: boolean,
  ) {
    super(code, message);
    this.name = "RetrievalResponseError";
  }
}

function hasRefusal(raw: Json): boolean {
  const content = records(raw.output).flatMap((o) => records(o.content));
  return content.some((c) => c.type === "refusal") || raw.stop_reason === "refusal";
}

function safetyBlocked(raw: Json, finish: string | null): boolean {
  const reasons = [
    finish,
    str(obj(raw.incomplete_details).reason),
    ...records(raw.candidates).map((c) => str(c.finishReason)),
  ];
  return reasons.some(
    (r) =>
      r !== undefined &&
      r !== null &&
      ["content-filter", "content_filter", "SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT"].includes(r),
  );
}

function rejectStatus(raw: Json, result: ProviderResult): void {
  const status = str(raw.status);
  if (status === "cancelled")
    throw new ProviderResponseError("provider_cancelled", "Provider reported cancellation", result);
  if (status === "failed" || (raw.error !== undefined && raw.error !== null))
    throw new ProviderResponseError(
      "provider_failed",
      "Provider reported generation failure",
      result,
    );
  if (status === "queued" || status === "in_progress")
    throw new ProviderResponseError(
      "provider_pending",
      "Provider returned a nonterminal response",
      result,
    );
}

/** Normalizes a completed SDK response and rejects terminal provider failures with retained usage. */
export function validateOutcome(
  input: ProviderInput,
  raw: Json,
  answer: string,
  finish: string | null,
  context: NormalizationContext = {},
): ProviderResult {
  const status = str(raw.status);
  const actualFinish = status && status !== "completed" ? status : finish;
  const result = normalize(input, raw, answer, actualFinish, context);
  rejectStatus(raw, result);
  const refusal = hasRefusal(raw),
    safety = safetyBlocked(raw, finish);
  if (refusal) result.warnings.push("Provider refused to answer this request.");
  if (safety) result.warnings.push("Provider blocked or filtered output for safety reasons.");
  if (status === "incomplete" || finish === "length" || raw.stop_reason === "max_tokens")
    result.warnings.push("Provider output is incomplete or truncated.");
  if (finish === "error")
    result.warnings.push("Provider reported an error finish reason; output may be partial.");
  if (!answer.trim() && !refusal && !safety)
    throw new ProviderResponseError(
      "provider_invalid_response",
      "Provider returned no answer or refusal",
      result,
    );
  return result;
}

/** Recovers terminal provider failures from wire responses when the SDK itself throws. */
export function validateCapturedFailure(
  input: ProviderInput,
  raw: Json,
  context: NormalizationContext = {},
): void {
  if (
    ["failed", "cancelled", "queued", "in_progress"].includes(String(raw.status)) ||
    (raw.error !== undefined && raw.error !== null)
  )
    rejectStatus(raw, normalize(input, raw, "", str(raw.status) ?? null, context));
}
