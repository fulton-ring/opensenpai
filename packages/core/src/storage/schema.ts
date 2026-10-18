/** Idempotent research tables and indexes, including immutable usage and reconciliation records. */
export const migrations = [
  `CREATE TABLE IF NOT EXISTS app_runs (
    workspace_id TEXT NOT NULL, id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    input_hash TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS app_observations (
    workspace_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
    PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,run_id,ordinal))`,
  `CREATE INDEX IF NOT EXISTS app_observations_run ON app_observations(workspace_id,run_id,ordinal)`,
  `CREATE TABLE IF NOT EXISTS app_attempts (
    workspace_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL,
    estimated_cost REAL, reserved_cost REAL NOT NULL, reported_cost REAL,
    PRIMARY KEY(workspace_id,id))`,
  `CREATE TABLE IF NOT EXISTS app_usage (
    workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, run_id TEXT NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY(workspace_id,attempt_id))`,
  `CREATE TABLE IF NOT EXISTS app_usage_reconciliations (
    workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, run_id TEXT NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY(workspace_id,attempt_id))`,
  `CREATE TABLE IF NOT EXISTS app_retrievals (
    workspace_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(workspace_id,id))`,
  `CREATE TABLE IF NOT EXISTS app_tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
    tool TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL)`,
];
