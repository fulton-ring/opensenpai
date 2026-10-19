import type {
  Observation,
  ObservationStatus,
  RetrievalBundle,
  RetrievalRecord,
  SpendAuthorization,
  Usage,
} from "../contracts.js";
import type { ResearchConnection } from "./client.js";
import { selectData } from "./records.js";

/** Immutable settlement evidence; delivery may repeat until this exact ID is acknowledged. */
export interface SettlementEvent {
  id: string;
  revision: number;
  attempt: SpendAuthorization;
  outcome: ObservationStatus;
  usage: Usage | null;
}

/** Return explicit zero evidence when durable state confirms no paid dispatch occurred. */
export function zeroUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    search_requests: 0,
    reported_cost_usd: 0,
    estimated_cost_usd: 0,
    raw: {},
  };
}

async function authorization(
  tx: ResearchConnection,
  workspace: string,
  attemptId: string,
  runId: string,
  estimate: number | null,
): Promise<SpendAuthorization> {
  const retrieval = attemptId.startsWith("retrieval:");
  const id = retrieval ? attemptId.slice("retrieval:".length) : attemptId;
  if (retrieval) {
    const [record] = await selectData<RetrievalRecord & { authorization?: SpendAuthorization }>(
      tx,
      "app_retrievals",
      workspace,
      "AND id=?",
      [id],
    );
    if (record?.authorization) return record.authorization;
  }
  const [observation] = await selectData<Observation>(
    tx,
    "app_observations",
    workspace,
    retrieval
      ? "AND run_id=? ORDER BY (json_extract(data,'$.retrieval_id')=?) DESC,ordinal LIMIT 1"
      : "AND json_extract(data,'$.attempt_id')=? LIMIT 1",
    retrieval ? [runId, id] : [id],
  );
  return {
    workspace_id: workspace,
    run_id: runId,
    observation_id: observation?.id ?? "",
    attempt_id: id,
    operation: retrieval ? "retrieval" : "model",
    estimated_cost_usd: estimate,
  };
}

function usageEvidence(attempt: SpendAuthorization, outcome: string, usage: unknown): Usage | null {
  if (outcome === "not_dispatched") return zeroUsage();
  if (!usage) return null;
  if (attempt.operation !== "retrieval") return usage as Usage;
  const bundle = usage as RetrievalBundle;
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_tokens: null,
    search_requests: outcome === "unknown_outcome" ? null : bundle.queries.length,
    reported_cost_usd: bundle.reported_cost_usd,
    estimated_cost_usd: bundle.estimated_cost_usd,
    raw: outcome === "succeeded" ? {} : bundle.raw_response,
  };
}

/** Append delivery evidence within the same transaction that accepted immutable usage. */
export async function enqueueSettlement(
  tx: ResearchConnection,
  workspace: string,
  attemptId: string,
  runId: string,
  data: string,
  revision: number,
): Promise<void> {
  const evidence = JSON.parse(data) as {
    outcome: string;
    usage: unknown;
    estimated_cost_usd: number | null;
  };
  const attempt = await authorization(tx, workspace, attemptId, runId, evidence.estimated_cost_usd);
  const event: SettlementEvent = {
    id: `${attemptId}:${revision === 1 ? "initial" : revision === 2 ? "reconciliation" : `revision:${revision}`}`,
    revision,
    attempt,
    outcome:
      evidence.outcome === "not_dispatched" ? "failed" : (evidence.outcome as ObservationStatus),
    usage: usageEvidence(attempt, evidence.outcome, evidence.usage),
  };
  await tx.execute({
    sql: "INSERT INTO app_settlements(workspace_id,id,data) VALUES(?,?,?) ON CONFLICT(workspace_id,id) DO NOTHING",
    args: [workspace, event.id, JSON.stringify(event)],
  });
}
