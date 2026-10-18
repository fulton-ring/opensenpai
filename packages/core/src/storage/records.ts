import type { InValue, ResultSet, Transaction } from "@libsql/client";
import {
  type Observation,
  ResearchError,
  type RunEstimate,
  type RunInput,
  type RunRecord,
  type Target,
} from "../contracts.js";

/** SQL execution capability used by research record serialization helpers. */
export type Connection = Pick<Transaction, "execute">;
/** Decode JSON-backed research rows returned by the storage client. */
export function decode<T>(rows: ResultSet): T[] {
  return rows.rows.map((row) => JSON.parse(String(row.data)) as T);
}
/** Serialize nested values deterministically for idempotency snapshot hashing. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
/** Persist an observation within its workspace using the caller’s transaction. */
export async function writeObservation(db: Connection, observation: Observation) {
  await db.execute({
    sql: "UPDATE app_observations SET data=? WHERE workspace_id=? AND id=?",
    args: [JSON.stringify(observation), observation.workspace_id, observation.id],
  });
}
/** Count every durable observation state for run aggregation. */
export function counts(observations: Observation[]): RunRecord["counts"] {
  const result = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    unknown_outcome: 0,
  };
  for (const item of observations) result[item.status]++;
  return result;
}
/** Derive a run’s lifecycle from observation counts and its cancellation request. */
export function status(run: RunRecord): RunRecord["status"] {
  if (run.counts.running) return "running";
  if (run.counts.pending) return "queued";
  if (run.cancel_requested) return "cancelled";
  if (run.counts.succeeded === run.total) return "succeeded";
  return run.counts.succeeded ? "partial" : "failed";
}
/** Create an unpersisted workspace batch with zero settled and reserved spend. */
export function newRun(
  input: RunInput,
  estimate: RunEstimate,
  workspace: string,
  now: string,
): RunRecord {
  return {
    id: crypto.randomUUID(),
    workspace_id: workspace,
    input,
    status: "queued",
    cancel_requested: false,
    total: input.prompts.length * input.targets.length * input.repetitions,
    counts: counts([]),
    estimated_cost_usd: estimate.estimated_cost_usd,
    reported_cost_usd: 0,
    reserved_cost_usd: 0,
    created_at: now,
    updated_at: now,
  };
}
/** Expand a run into prompt-target repetitions using snapshotted targets and estimates. */
export function newObservations(
  run: RunRecord,
  targets: Target[],
  estimate: RunEstimate,
): Observation[] {
  const rows: Observation[] = [];
  for (const prompt of run.input.prompts) {
    for (const selection of run.input.targets) {
      const targetId = typeof selection === "string" ? selection : selection.id;
      const target = targets.find((item) => item.id === targetId);
      if (!target) throw new ResearchError("TARGET_NOT_FOUND", `Missing target ${targetId}`);
      for (let repetition = 0; repetition < run.input.repetitions; repetition++) {
        const price = estimate.observations.find(
          (item) =>
            item.prompt_id === prompt.id &&
            item.target_id === targetId &&
            item.repetition === repetition,
        );
        rows.push({
          id: crypto.randomUUID(),
          workspace_id: run.workspace_id,
          run_id: run.id,
          ordinal: rows.length,
          prompt,
          target,
          repetition,
          locale: run.input.locale,
          status: "pending",
          attempt_id: null,
          owner: null,
          lease_until: null,
          dispatched_at: null,
          retrieval_id: null,
          estimated_cost_usd: price?.estimated_cost_usd ?? null,
          result: null,
          error: null,
          created_at: run.created_at,
          updated_at: run.created_at,
        });
      }
    }
  }
  return rows;
}
/** Read JSON records from a trusted internal table within one workspace. */
export async function selectData<T>(
  db: Connection,
  table: string,
  workspace: string,
  clause = "",
  args: InValue[] = [],
): Promise<T[]> {
  return decode<T>(
    await db.execute({
      sql: `SELECT data FROM ${table} WHERE workspace_id=? ${clause}`,
      args: [workspace, ...args],
    }),
  );
}

/** Decode and validate the timestamp and ID used for stable run pagination. */
export function readRunCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      !Number.isFinite(Date.parse(value[0])) ||
      !value[1]
    )
      throw new Error("Invalid run cursor");
    return [value[0], value[1]];
  } catch {
    throw new ResearchError("INVALID_CURSOR", "Run cursor is invalid");
  }
}
