import type { D1QueryResult } from "@mastra/cloudflare-d1";
import { ResearchError } from "@opensenpai/core/contracts";
import {
  deserializeResearchError,
  RESEARCH_ENDPOINT,
  RESEARCH_METHODS,
  type ResearchStorage,
} from "@opensenpai/core/storage";

/** Private container host handler; callers cannot configure a public SQL proxy. */
export type BridgeFetch = (url: string, init: RequestInit) => Promise<Response>;
const D1_ENDPOINT = "http://cloudflare-storage/d1";

async function request<T>(bridgeFetch: BridgeFetch, endpoint: string, body: unknown): Promise<T> {
  const response = await bridgeFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object")
    throw new ResearchError("STORAGE_PROTOCOL_ERROR", "Invalid Cloudflare storage response");
  if ("error" in payload) {
    const error = payload.error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      "message" in error &&
      typeof error.message === "string" &&
      "retryable" in error &&
      typeof error.retryable === "boolean"
    )
      throw deserializeResearchError({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    throw new ResearchError("STORAGE_PROTOCOL_ERROR", "Invalid Cloudflare storage failure");
  }
  if (!response.ok)
    throw new ResearchError(
      "STORAGE_HTTP_ERROR",
      `Cloudflare storage returned HTTP ${response.status}`,
    );
  if (!("result" in payload))
    throw new ResearchError(
      "STORAGE_PROTOCOL_ERROR",
      "Cloudflare storage response is missing its result",
    );
  return payload.result as T;
}

export function createCloudflareResearchStorage(
  workspaceId: string,
  bridgeFetch: BridgeFetch = fetch,
): ResearchStorage {
  const methods = Object.fromEntries(
    RESEARCH_METHODS.map((method) => [
      method,
      (...args: unknown[]) => request(bridgeFetch, RESEARCH_ENDPOINT, { method, args }),
    ]),
  );
  return {
    ...methods,
    workspaceId,
    // Closing this process must never destroy the owning Durable Object's records.
    close: async () => {},
  } as ResearchStorage;
}

export async function createCloudflareD1Storage(
  workspaceId: string,
  bridgeFetch: BridgeFetch = fetch,
) {
  const { D1Store } = await import("@mastra/cloudflare-d1");
  return new D1Store({
    id: `opensenpai-${workspaceId}`,
    client: {
      query: async (query) => ({
        result: await request<D1QueryResult>(bridgeFetch, D1_ENDPOINT, query),
      }),
    },
  });
}
