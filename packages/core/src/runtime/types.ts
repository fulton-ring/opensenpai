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
  SpendAuthorization,
  Usage,
} from "../contracts.js";
import type { ProviderRegistry, RetrievalInput } from "../providers/types.js";
import type { SettlementEvent } from "../storage/settlements.js";

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
  listPendingSettlements?(
    limit?: number,
    attempt?: SpendAuthorization,
    includeDeferred?: boolean,
  ): Promise<SettlementEvent[]>;
  correctUsage?(id: string, attemptId: string, usage: Usage): Promise<void>;
  listPendingUsageReconciliations?(
    limit?: number,
    includeDeferred?: boolean,
  ): Promise<Observation[]>;
  claimUsageReconciliation?(attemptId: string, owner: string, leaseMs?: number): Promise<boolean>;
  finishUsageReconciliation?(id: string, owner: string, usage: Usage | null): Promise<void>;
  deferSettlement?(id: string): Promise<void>;
  ackSettlement?(id: string): Promise<void>;
  setRetrieval?(observationId: string, retrievalId: string): Promise<void>;
  getRetrieval(id: string): Promise<RetrievalRecord | null>;
  claimRetrieval(
    id: string,
    runId: string,
    owner: string,
    leaseMs: number,
    estimatedCost: number,
    authorization?: SpendAuthorization,
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
/** Configure orchestration, persistence, adapter injection, and paid-operation hooks. */
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
  /** Host settlement callback deadline, capped at ten seconds. */
  settlementTimeoutMs?: number;
  cancellationPollMs?: number;
  /** Queue consumers use only executeObservation; no native background workers. */
  directOnly?: boolean;
  dispatchMode?: "native" | "external";
  onError?: (error: unknown) => void;
}
