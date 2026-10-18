import type { PubSub } from "@mastra/core/events";
import type { MastraCompositeStore } from "@mastra/core/storage";
import type {
  ExecutionHooks,
  Failure,
  Observation,
  ProviderInput,
  ProviderResult,
  RetrievalBundle,
  RetrievalRecord,
  RunRecord,
} from "../contracts.js";

import type { ProviderRegistry, RetrievalInput } from "../providers/types.js";

/** The runtime uses the persistence boundary, never a process-local job lock, to authorize work. */
export interface RuntimeStore {
  getObservation(id: string): Promise<Observation | null>;
  getRun(id: string): Promise<RunRecord | null>;
  listPending(limit?: number): Promise<Observation[]>;
  listUnqueued(limit?: number): Promise<Observation[]>;
  markQueued(id: string): Promise<void>;
  resetPendingQueue?(): Promise<unknown>;
  claim(id: string, owner: string, leaseMs?: number): Promise<Observation | null>;
  markDispatched(id: string, attemptId: string): Promise<boolean>;
  succeed(id: string, attemptId: string, result: ProviderResult): Promise<void>;
  fail(
    id: string,
    attemptId: string,
    error: Failure,
    status?: "failed" | "unknown_outcome" | "cancelled",
    partialResult?: ProviderResult,
  ): Promise<void>;
  cancelRun(id: string): Promise<unknown>;
  recoverExpired(): Promise<unknown>;
  setRetrieval?(observationId: string, retrievalId: string): Promise<void>;
  getRetrieval(id: string): Promise<RetrievalRecord | null>;
  claimRetrieval(
    id: string,
    runId: string,
    owner: string,
    leaseMs: number,
    estimatedCost: number,
  ): Promise<boolean>;
  finishRetrieval(bundle: RetrievalBundle, owner: string, runId: string): Promise<void>;
  failRetrieval(
    id: string,
    owner: string,
    error: Failure,
    unknown: boolean,
    partialBundle?: RetrievalBundle,
    notDispatched?: boolean,
  ): Promise<void>;
}
export interface RuntimeOptions {
  store: RuntimeStore;
  env: Record<string, string | undefined>;
  role: "all" | "api" | "worker";
  providers?: ProviderRegistry;
  retrieveSearch?: (
    input: RetrievalInput,
    env: Record<string, string | undefined>,
  ) => Promise<RetrievalBundle>;
  executeProvider?: (
    input: ProviderInput,
    env: Record<string, string | undefined>,
  ) => Promise<ProviderResult>;
  retrieveExa?: (
    input: {
      id: string;
      queries: string[];
      max_results: number;
      max_characters: number;
      signal: AbortSignal;
    },
    env: Record<string, string | undefined>,
  ) => Promise<RetrievalBundle>;
  hooks?: ExecutionHooks;
  pubsub?: PubSub;
  valkeyUrl?: string;
  storage?: MastraCompositeStore;
  /** Tests may shorten this; production can never exceed 120 seconds. */
  timeoutMs?: number;
  maxConcurrent?: number;
  repairIntervalMs?: number;
  cancellationPollMs?: number;
  /** Queue consumers use only executeObservation; no native background workers. */
  directOnly?: boolean;
  dispatchMode?: "native" | "external";
  onError?: (error: unknown) => void;
}
