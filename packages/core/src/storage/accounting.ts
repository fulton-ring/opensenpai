import type { ResearchConnection } from "./client.js";
import { canonical } from "./records.js";
import { enqueueSettlement } from "./settlements.js";

/** Append immutable evidence, importing legacy revisions before assigning the next version. */
export async function appendUsageRevision(
  tx: ResearchConnection,
  workspace: string,
  attempt: string,
  run: string,
  outcome: string,
  actual: number | null,
  usage: unknown,
  now: string,
  trusted = false,
): Promise<boolean> {
  await importLegacyRevisions(tx, workspace, attempt);
  const previous = await tx.execute({
    sql: "SELECT revision,data FROM app_usage_revisions WHERE workspace_id=? AND attempt_id=? ORDER BY revision DESC LIMIT 1",
    args: [workspace, attempt],
  });
  const prior = previous.rows[0] ? JSON.parse(String(previous.rows[0].data)) : null;
  if (
    prior &&
    canonical([prior.outcome, prior.usage, prior.reported_cost_usd]) ===
      canonical([outcome, usage, actual])
  )
    return false;
  if (!trusted && prior?.reported_cost_usd != null) return false;
  // Missing evidence cannot replace a known actual, even when execution later changes state.
  if (prior?.reported_cost_usd != null && actual === null) return false;
  const revision = Number(previous.rows[0]?.revision ?? 0) + 1;
  const estimates = await tx.execute({
    sql: "SELECT estimated_cost FROM app_attempts WHERE workspace_id=? AND id=?",
    args: [workspace, attempt],
  });
  const data = JSON.stringify({
    outcome,
    usage,
    reported_cost_usd: actual,
    estimated_cost_usd: estimates.rows[0]?.estimated_cost ?? null,
    created_at: now,
  });
  await tx.execute({
    sql: "INSERT INTO app_usage_revisions(workspace_id,attempt_id,revision,run_id,data) VALUES(?,?,?,?,?)",
    args: [workspace, attempt, revision, run, data],
  });
  if (revision <= 2)
    await tx.execute({
      sql: `INSERT OR IGNORE INTO ${revision === 1 ? "app_usage" : "app_usage_reconciliations"}(workspace_id,attempt_id,run_id,data) VALUES(?,?,?,?)`,
      args: [workspace, attempt, run, data],
    });
  await enqueueSettlement(tx, workspace, attempt, run, data, revision);
  if (actual === null && outcome !== "not_dispatched") {
    await tx.execute({
      sql: "INSERT OR IGNORE INTO app_usage_pending(workspace_id,attempt_id,next_at) VALUES(?,?,?)",
      args: [workspace, attempt, now],
    });
  } else {
    await tx.execute({
      sql: "DELETE FROM app_usage_pending WHERE workspace_id=? AND attempt_id=?",
      args: [workspace, attempt],
    });
  }
  return true;
}

async function importLegacyRevisions(
  tx: ResearchConnection,
  workspace: string,
  attempt: string,
): Promise<void> {
  for (const [table, revision] of [
    ["app_usage", 1],
    ["app_usage_reconciliations", 2],
  ] as const) {
    await tx.execute({
      sql: `INSERT OR IGNORE INTO app_usage_revisions(workspace_id,attempt_id,revision,run_id,data)
      SELECT workspace_id,attempt_id,?,run_id,data FROM ${table} WHERE workspace_id=? AND attempt_id=?`,
      args: [revision, workspace, attempt],
    });
  }
}
