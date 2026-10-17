import { type Failure, ResearchError } from "../contracts.js";
import type { ResearchStorage } from "./index.js";

export const RESEARCH_ENDPOINT = "http://cloudflare-storage/research";
export const RESEARCH_METHODS = [
  "initialize",
  "createRun",
  "getRun",
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

export type ResearchMethod = (typeof RESEARCH_METHODS)[number];
export type ResearchArgs<M extends ResearchMethod> = Parameters<ResearchStorage[M]>;
export type ResearchResult<M extends ResearchMethod> = Awaited<ReturnType<ResearchStorage[M]>>;
export type ResearchRequest = {
  [M in ResearchMethod]: { method: M; args: ResearchArgs<M> };
}[ResearchMethod];
export type ResearchResponse<T = unknown> = { result: T } | { error: Failure };

export function isResearchRequest(value: unknown): value is ResearchRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.method === "string" &&
    RESEARCH_METHODS.some((method) => method === request.method) &&
    Array.isArray(request.args)
  );
}

export function serializeResearchError(error: unknown): Failure {
  return error instanceof ResearchError
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : {
        code: "STORAGE_ERROR",
        message: "Research storage operation failed",
        retryable: false,
      };
}

export function deserializeResearchError(error: Failure): ResearchError {
  return new ResearchError(error.code, error.message, error.retryable);
}
