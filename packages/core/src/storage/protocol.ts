import { type Failure, ResearchError } from "../contracts.js";
import type { ResearchStorage } from "./index.js";

/** Private container outbound address for research persistence; never a public API route. */
export const RESEARCH_ENDPOINT = "http://cloudflare-storage/research";
/** Explicit persistence RPC allowlist excluding client access and destructive lifecycle calls. */
export const RESEARCH_METHODS = [
  "initialize",
  "createRun",
  "getRun",
  "getRunByIdempotencyKey",
  "getObservation",
  "listRuns",
  "listRunPage",
  "getResults",
  "listPending",
  "listUnqueued",
  "resetPendingQueue",
  "markQueued",
  "setRetrieval",
  "claim",
  "markDispatched",
  "succeed",
  "fail",
  "cancelRun",
  "recoverExpired",
  "getRetrieval",
  "claimRetrieval",
  "finishRetrieval",
  "failRetrieval",
  "recordToolCall",
  "listToolCalls",
] as const satisfies readonly (keyof ResearchStorage)[];

/** Persistence operation allowed across the private container bridge. */
export type ResearchMethod = (typeof RESEARCH_METHODS)[number];
/** Typed arguments associated with an allowlisted persistence operation. */
export type ResearchArgs<M extends ResearchMethod> = Parameters<ResearchStorage[M]>;
/** Resolved return value of an allowlisted persistence operation. */
export type ResearchResult<M extends ResearchMethod> = Awaited<ReturnType<ResearchStorage[M]>>;
/** Discriminated private RPC envelope preserving each method’s argument contract. */
export type ResearchRequest = {
  [M in ResearchMethod]: { method: M; args: ResearchArgs<M> };
}[ResearchMethod];
/** Private RPC outcome containing either a value or a sanitized domain failure. */
export type ResearchResponse<T = unknown> = { result: T } | { error: Failure };

/** Validate the RPC envelope and allowlist before dispatch; methods validate their inputs. */
export function isResearchRequest(value: unknown): value is ResearchRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.method === "string" &&
    RESEARCH_METHODS.some((method) => method === request.method) &&
    Array.isArray(request.args)
  );
}

/** Preserve domain failures while hiding unexpected storage implementation details. */
export function serializeResearchError(error: unknown): Failure {
  return error instanceof ResearchError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : {
        code: "STORAGE_ERROR",
        message: "Research storage operation failed",
        retryable: false,
      };
}

/** Restore domain error semantics from a private persistence RPC failure. */
export function deserializeResearchError(error: Failure): ResearchError {
  return new ResearchError(error.code, error.message, error.retryable);
}
