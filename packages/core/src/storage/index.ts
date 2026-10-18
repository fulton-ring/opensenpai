import type { InValue } from "@libsql/client";
import {
  type Failure,
  type Observation,
  type ObservationStatus,
  type ProviderResult,
  ResearchError,
  type ResultQuery,
  type RetrievalBundle,
  type RetrievalRecord,
  type RunEstimate,
  type RunInput,
  type RunRecord,
  type SpendAuthorization,
  type Target,
} from "../contracts.js";
import type { ResearchClient, ResearchConnection, TransactionRunner } from "./client.js";
import { writeLock } from "./local-write.js";
import {
  canonical,
  counts,
  newObservations,
  newRun,
  readRunCursor,
  selectData,
  status,
  writeObservation,
} from "./records.js";
import { migrations } from "./schema.js";
import { enqueueSettlement, type SettlementEvent, zeroUsage } from "./settlements.js";

export type { SettlementEvent } from "./settlements.js";

/** Inject a clock or native transaction runner without changing research state semantics. */
export interface StoreOptions {
  clock?: () => Date;
  transactionRunner?: TransactionRunner;
}
/** Filter workspace runs and page them by creation time and stable ID. */
export interface RunListQuery {
  project?: string;
  limit?: number;
  before?: string;
  cursor?: string;
}
/** Persisted MCP invocation metadata used to correlate agent activity with runs. */
export interface ToolCall {
  tool: string;
  run_id: string | null;
  created_at: string;
}

/** Persist workspace-isolated research, atomic execution claims, and immutable spend evidence. */
export class ResearchStore {
  private readonly clock: () => Date;
  private readonly transactionRunner?: TransactionRunner;
  constructor(
    readonly client: ResearchClient,
    readonly workspaceId = "local",
    options: StoreOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.transactionRunner = options.transactionRunner;
  }

  async initialize(): Promise<void> {
    await writeLock(this.client, async () => {
      await this.client.batch(migrations, "write");
    });
  }

  async close(): Promise<void> {
    this.client.close();
  }

  private now() {
    return this.clock().toISOString();
  }

  private async transaction<T>(operation: (tx: ResearchConnection) => Promise<T>): Promise<T> {
    if (this.transactionRunner) return this.transactionRunner(operation);
    return writeLock(this.client, async () => {
      if (!this.client.transaction)
        throw new Error("Research storage requires a transaction runner");
      const tx = await this.client.transaction("write");
      try {
        const result = await operation(tx);
        await tx.commit();
        return result;
      } finally {
        tx.close();
      }
    });
  }

  private async observations(db: ResearchConnection, runId: string) {
    return selectData<Observation>(
      db,
      "app_observations",
      this.workspaceId,
      "AND run_id=? ORDER BY ordinal",
      [runId],
    );
  }

  private async observation(db: ResearchConnection, id: string) {
    return (
      (
        await selectData<Observation>(db, "app_observations", this.workspaceId, "AND id=?", [id])
      )[0] ?? null
    );
  }

  private async run(db: ResearchConnection, id: string): Promise<RunRecord | null> {
    const row = (
      await selectData<RunRecord>(db, "app_runs", this.workspaceId, "AND id=?", [id])
    )[0];
    if (!row) return null;
    row.counts = counts(await this.observations(db, id));
    row.status = status(row);
    const costs = await db.execute({
      sql: "SELECT SUM(reserved_cost) reserved, SUM(reported_cost) reported FROM app_attempts WHERE workspace_id=? AND run_id=?",
      args: [this.workspaceId, id],
    });
    row.reserved_cost_usd = Number(costs.rows[0]?.reserved ?? 0);
    row.reported_cost_usd = Number(costs.rows[0]?.reported ?? 0);
    return row;
  }

  async createRun(input: RunInput, targets: Target[], estimate: RunEstimate) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical({ input, targets })),
    );
    const inputHash = Array.from(new Uint8Array(hash), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    return this.transaction(async (tx) => {
      const existing = await tx.execute({
        sql: "SELECT id FROM app_runs WHERE workspace_id=? AND idempotency_key=?",
        args: [this.workspaceId, input.idempotency_key],
      });
      const prior = existing.rows[0];
      if (prior) {
        const run = await this.run(tx, String(prior.id));
        if (!run) throw new Error("Missing idempotent run");
        // Compare stored caller input: legacy hashes also include mutable resolved targets.
        if (canonical(run.input) !== canonical(input))
          throw new ResearchError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key already has a different input",
          );
        return { run, created: false };
      }
      const run = newRun(input, estimate, this.workspaceId, this.now());
      const rows = newObservations(run, targets, estimate);
      run.counts = counts(rows);
      await tx.execute({
        sql: "INSERT INTO app_runs(workspace_id,id,idempotency_key,input_hash,data) VALUES(?,?,?,?,?)",
        args: [this.workspaceId, run.id, input.idempotency_key, inputHash, JSON.stringify(run)],
      });
      for (const item of rows)
        await tx.execute({
          sql: "INSERT INTO app_observations(workspace_id,id,run_id,ordinal,data) VALUES(?,?,?,?,?)",
          args: [this.workspaceId, item.id, run.id, item.ordinal, JSON.stringify(item)],
        });
      return { run, created: true };
    });
  }

  /** Find an accepted run within this workspace without resolving provider metadata again. */
  async getRunByIdempotencyKey(key: string): Promise<RunRecord | null> {
    const existing = await this.client.execute({
      sql: "SELECT id FROM app_runs WHERE workspace_id=? AND idempotency_key=?",
      args: [this.workspaceId, key],
    });
    const id = existing.rows[0]?.id;
    return id === undefined ? null : this.getRun(String(id));
  }

  async getRun(id: string) {
    return this.run(this.client, id);
  }

  async getObservation(id: string) {
    return this.observation(this.client, id);
  }

  async listRuns(query: RunListQuery = {}): Promise<RunRecord[]> {
    return (await this.listRunPage(query)).runs;
  }

  async listRunPage(
    query: RunListQuery = {},
  ): Promise<{ runs: RunRecord[]; next_cursor: string | null }> {
    const clauses = ["AND 1=1"];
    const args: InValue[] = [];
    if (query.project) {
      clauses.push("AND json_extract(data,'$.input.project')=?");
      args.push(query.project);
    }
    if (query.before) {
      clauses.push("AND json_extract(data,'$.created_at')<?");
      args.push(query.before);
    }
    if (query.cursor) {
      const [createdAt, id] = readRunCursor(query.cursor);
      clauses.push("AND (json_extract(data,'$.created_at'),id)<(?,?)");
      args.push(createdAt, id);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
    args.push(limit + 1);
    const rows = await selectData<RunRecord>(
      this.client,
      "app_runs",
      this.workspaceId,
      `${clauses.join(" ")} ORDER BY json_extract(data,'$.created_at') DESC,id DESC LIMIT ?`,
      args,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const runs = await Promise.all(page.map(async (row) => (await this.getRun(row.id)) ?? row));
    return {
      runs,
      next_cursor:
        rows.length > limit && last
          ? encodeURIComponent(JSON.stringify([last.created_at, last.id]))
          : null,
    };
  }

  async getResults(query: ResultQuery) {
    const rows = (await this.observations(this.client, query.run_id)).filter(
      (row) =>
        row.ordinal > (query.cursor ?? -1) &&
        (!query.target_id || row.target.id === query.target_id) &&
        (!query.prompt_id || row.prompt.id === query.prompt_id) &&
        (!query.status || row.status === query.status),
    );
    const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
    const observations = rows.slice(0, limit);
    if (!query.include_raw) for (const row of observations) this.omitRaw(row);
    return {
      observations,
      next_cursor: rows.length > limit ? (observations.at(-1)?.ordinal ?? null) : null,
    };
  }

  private omitRaw(row: Observation) {
    if (!row.result) return;
    Reflect.deleteProperty(row.result, "raw_response");
    Reflect.deleteProperty(row.result.usage, "raw");
    for (const source of row.result.sources) {
      Reflect.deleteProperty(source, "text");
      Reflect.deleteProperty(source, "metadata");
    }
    for (const citation of row.result.citations) Reflect.deleteProperty(citation, "metadata");
  }

  async listPending(limit = 100) {
    return this.pending(limit, false);
  }

  /** List durable billing deliveries in their committed evidence order. */
  async listPendingSettlements(limit = 100): Promise<SettlementEvent[]> {
    return selectData<SettlementEvent>(
      this.client,
      "app_settlements",
      this.workspaceId,
      "ORDER BY rowid LIMIT ?",
      [Math.max(1, Math.min(limit, 1000))],
    );
  }

  /** Acknowledge only one successfully delivered event within this workspace. */
  async ackSettlement(id: string): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.execute({
        sql: "DELETE FROM app_settlements WHERE workspace_id=? AND id=?",
        args: [this.workspaceId, id],
      });
    });
  }

  async listUnqueued(limit = 100, runId?: string) {
    return this.pending(limit, true, runId);
  }

  private async pending(limit: number, unqueued: boolean, runId?: string) {
    const args: InValue[] = runId ? [runId] : [];
    args.push(Math.max(1, Math.min(limit, 1000)));
    return selectData<Observation>(
      this.client,
      "app_observations",
      this.workspaceId,
      `AND json_extract(data,'$.status')='pending' ${unqueued ? "AND queued=0" : ""} ${runId ? "AND run_id=?" : ""} ORDER BY rowid LIMIT ?`,
      args,
    );
  }

  async resetPendingQueue(): Promise<number> {
    return this.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "UPDATE app_observations SET queued=0 WHERE workspace_id=? AND queued=1 AND json_extract(data,'$.status')='pending'",
        args: [this.workspaceId],
      });
      return result.rowsAffected;
    });
  }

  async markQueued(id: string) {
    await this.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE app_observations SET queued=1 WHERE workspace_id=? AND id=?",
        args: [this.workspaceId, id],
      });
    });
  }

  async setRetrieval(id: string, retrievalId: string) {
    await this.transaction(async (tx) => {
      const row = await this.observation(tx, id);
      if (!row) return;
      row.retrieval_id = retrievalId;
      row.updated_at = this.now();
      await writeObservation(tx, row);
    });
  }

  private async reserve(
    tx: ResearchConnection,
    id: string,
    run: RunRecord,
    estimate: number | null,
  ) {
    if (run.cancel_requested) return false;
    const cap = run.input.max_estimated_cost_usd;
    if (
      cap !== undefined &&
      (estimate === null || run.reported_cost_usd + run.reserved_cost_usd + estimate > cap + 1e-12)
    )
      return false;
    await tx.execute({
      sql: "INSERT INTO app_attempts(workspace_id,id,run_id,estimated_cost,reserved_cost) VALUES(?,?,?,?,?)",
      args: [this.workspaceId, id, run.id, estimate, estimate ?? 0],
    });
    return true;
  }

  async claim(id: string, owner: string, leaseMs = 150_000): Promise<Observation | null> {
    return this.transaction(async (tx) => {
      const row = await this.observation(tx, id);
      if (row?.status !== "pending") return null;
      const run = await this.run(tx, row.run_id);
      const attemptId = crypto.randomUUID();
      if (!run || run.cancel_requested) return null;
      if (!(await this.reserve(tx, attemptId, run, row.estimated_cost_usd))) {
        row.status = "failed";
        row.updated_at = this.now();
        row.error = {
          code: "BUDGET_EXCEEDED",
          message: "Run budget cannot reserve this observation",
          retryable: false,
        };
        await writeObservation(tx, row);
        await this.touchRun(tx, row.run_id);
        return null;
      }
      Object.assign(row, {
        status: "running",
        owner,
        attempt_id: attemptId,
        lease_until: new Date(this.clock().getTime() + leaseMs).toISOString(),
        dispatched_at: null,
        updated_at: this.now(),
      });
      await writeObservation(tx, row);
      return row;
    });
  }

  async markDispatched(id: string, attemptId: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const row = await this.observation(tx, id);
      if (row?.status !== "running" || row.attempt_id !== attemptId || row.dispatched_at)
        return false;
      const run = await this.run(tx, row.run_id);
      if (!run || run.cancel_requested) return false;
      row.dispatched_at = this.now();
      row.updated_at = this.now();
      await writeObservation(tx, row);
      return true;
    });
  }

  private async settle(
    tx: ResearchConnection,
    attemptId: string,
    runId: string,
    outcome: string,
    actual: number | null,
    release: boolean,
    usage: unknown,
  ) {
    if (!(await this.recordUsage(tx, attemptId, runId, outcome, actual, usage))) return;
    await tx.execute({
      sql: "UPDATE app_attempts SET reserved_cost=CASE WHEN ? THEN 0 ELSE reserved_cost END,reported_cost=? WHERE workspace_id=? AND id=?",
      args: [release ? 1 : 0, actual, this.workspaceId, attemptId],
    });
    await this.touchRun(tx, runId);
  }

  private async recordUsage(
    tx: ResearchConnection,
    attemptId: string,
    runId: string,
    outcome: string,
    actual: number | null,
    usage: unknown,
  ) {
    const attempts = await tx.execute({
      sql: "SELECT estimated_cost FROM app_attempts WHERE workspace_id=? AND id=?",
      args: [this.workspaceId, attemptId],
    });
    const data = JSON.stringify({
      outcome,
      usage,
      estimated_cost_usd: attempts.rows[0]?.estimated_cost ?? null,
      reported_cost_usd: actual,
      created_at: this.now(),
    });
    const args: InValue[] = [this.workspaceId, attemptId, runId, data];
    const inserted = await tx.execute({
      sql: "INSERT INTO app_usage(workspace_id,attempt_id,run_id,data) VALUES(?,?,?,?) ON CONFLICT(workspace_id,attempt_id) DO NOTHING",
      args,
    });
    if (inserted.rowsAffected) {
      await enqueueSettlement(tx, this.workspaceId, attemptId, runId, data, false);
      return true;
    }
    const previous = await tx.execute({
      sql: "SELECT json_extract(data,'$.outcome') outcome FROM app_usage WHERE workspace_id=? AND attempt_id=?",
      args: [this.workspaceId, attemptId],
    });
    if (
      previous.rows[0]?.outcome !== "unknown_outcome" ||
      (!["succeeded", "failed", "cancelled", "not_dispatched"].includes(outcome) && usage === null)
    )
      return false;
    const corrected = await tx.execute({
      sql: "INSERT INTO app_usage_reconciliations(workspace_id,attempt_id,run_id,data) VALUES(?,?,?,?) ON CONFLICT(workspace_id,attempt_id) DO NOTHING",
      args,
    });
    if (!corrected.rowsAffected) return false;
    await enqueueSettlement(tx, this.workspaceId, attemptId, runId, data, true);
    return true;
  }

  private async touchRun(tx: ResearchConnection, id: string) {
    const run = await this.run(tx, id);
    if (!run) return;
    run.updated_at = this.now();
    await tx.execute({
      sql: "UPDATE app_runs SET data=? WHERE workspace_id=? AND id=?",
      args: [JSON.stringify(run), this.workspaceId, id],
    });
  }

  async succeed(id: string, attemptId: string, result: ProviderResult): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await this.observation(tx, id);
      if (
        !row ||
        !["running", "unknown_outcome"].includes(row.status) ||
        row.attempt_id !== attemptId
      )
        return;
      Object.assign(row, {
        status: "succeeded",
        result,
        error: null,
        lease_until: null,
        updated_at: this.now(),
      });
      await writeObservation(tx, row);
      await this.settle(
        tx,
        attemptId,
        row.run_id,
        "succeeded",
        result.usage.reported_cost_usd,
        result.usage.reported_cost_usd !== null,
        result.usage,
      );
    });
  }

  async fail(
    id: string,
    attemptId: string,
    error: Failure,
    outcome: "failed" | "unknown_outcome" | "cancelled",
    partialResult?: ProviderResult,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await this.observation(tx, id);
      const lateEvidence = row?.status === "unknown_outcome" && partialResult !== undefined;
      if (!row || (row.status !== "running" && !lateEvidence) || row.attempt_id !== attemptId)
        return;
      const actual = partialResult?.usage.reported_cost_usd ?? null;
      const unbilled =
        partialResult === undefined &&
        (row.dispatched_at === null || error.code === "provider_not_dispatched") &&
        outcome !== "unknown_outcome";
      Object.assign(row, {
        status: outcome,
        error,
        result: partialResult ?? row.result,
        lease_until: null,
        updated_at: this.now(),
      });
      await writeObservation(tx, row);
      await this.settle(
        tx,
        attemptId,
        row.run_id,
        outcome,
        actual,
        actual !== null || unbilled,
        partialResult?.usage ?? (unbilled ? zeroUsage() : null),
      );
    });
  }

  async cancelRun(id: string): Promise<RunRecord | null> {
    return this.transaction(async (tx) => {
      const run = await this.run(tx, id);
      if (!run) return null;
      if (!run.counts.pending && !run.counts.running) return run;
      run.cancel_requested = true;
      run.updated_at = this.now();
      await tx.execute({
        sql: "UPDATE app_runs SET data=? WHERE workspace_id=? AND id=?",
        args: [JSON.stringify(run), this.workspaceId, id],
      });
      for (const row of await this.observations(tx, id)) {
        if (row.status !== "pending") continue;
        row.status = "cancelled";
        row.updated_at = this.now();
        await writeObservation(tx, row);
      }
      return this.run(tx, id);
    });
  }

  async recoverExpired(): Promise<number> {
    return this.transaction(async (tx) => {
      const rows = await selectData<Observation>(
        tx,
        "app_observations",
        this.workspaceId,
        "AND json_extract(data,'$.status')='running' AND json_extract(data,'$.lease_until')<=?",
        [this.now()],
      );
      for (const row of rows) await this.recoverObservation(tx, row);
      const retrievals = await selectData<RetrievalRecord>(
        tx,
        "app_retrievals",
        this.workspaceId,
        "AND json_extract(data,'$.status')='running' AND json_extract(data,'$.lease_until')<=?",
        [this.now()],
      );
      for (const row of retrievals)
        await this.retrievalFailure(
          tx,
          row,
          {
            code: "LEASE_EXPIRED",
            message: "Retrieval outcome unknown after lease expiry",
            retryable: false,
          },
          true,
        );
      return rows.length + retrievals.length;
    });
  }

  private async recoverObservation(tx: ResearchConnection, row: Observation) {
    const run = await this.run(tx, row.run_id);
    const dispatched = row.dispatched_at !== null;
    const outcome: ObservationStatus = dispatched
      ? "unknown_outcome"
      : run?.cancel_requested
        ? "cancelled"
        : "pending";
    row.status = outcome;
    row.updated_at = this.now();
    row.lease_until = null;
    row.error = dispatched
      ? {
          code: "LEASE_EXPIRED",
          message: "Provider outcome unknown after lease expiry",
          retryable: false,
        }
      : null;
    await writeObservation(tx, row);
    if (outcome === "pending")
      await tx.execute({
        sql: "UPDATE app_observations SET queued=0 WHERE workspace_id=? AND id=?",
        args: [this.workspaceId, row.id],
      });
    if (row.attempt_id)
      await this.settle(
        tx,
        row.attempt_id,
        row.run_id,
        dispatched ? "unknown_outcome" : "not_dispatched",
        null,
        !dispatched,
        dispatched ? null : zeroUsage(),
      );
  }

  async getRetrieval(id: string): Promise<RetrievalRecord | null> {
    return (
      (
        await selectData<RetrievalRecord>(
          this.client,
          "app_retrievals",
          this.workspaceId,
          "AND id=?",
          [id],
        )
      )[0] ?? null
    );
  }

  async claimRetrieval(
    id: string,
    runId: string,
    owner: string,
    leaseMs: number,
    estimatedCost: number,
    authorization?: SpendAuthorization,
  ): Promise<boolean> {
    return this.transaction(async (tx) => {
      if ((await selectData(tx, "app_retrievals", this.workspaceId, "AND id=?", [id])).length)
        return false;
      const run = await this.run(tx, runId);
      if (!run) throw new ResearchError("RUN_NOT_FOUND", "Retrieval run does not exist");
      if (run.cancel_requested) throw new ResearchError("cancelled", "Retrieval run was cancelled");
      if (!(await this.reserve(tx, `retrieval:${id}`, run, estimatedCost)))
        throw new ResearchError("BUDGET_EXCEEDED", "Run budget cannot reserve this retrieval");
      const record: RetrievalRecord & { authorization?: SpendAuthorization } = {
        id,
        status: "running",
        owner,
        lease_until: new Date(this.clock().getTime() + leaseMs).toISOString(),
        bundle: null,
        error: null,
        ...(authorization ? { authorization } : {}),
      };
      await tx.execute({
        sql: "INSERT INTO app_retrievals(workspace_id,id,run_id,data) VALUES(?,?,?,?)",
        args: [this.workspaceId, id, runId, JSON.stringify(record)],
      });
      return true;
    });
  }

  async finishRetrieval(bundle: RetrievalBundle, owner: string, runId: string): Promise<void> {
    await this.transaction(async (tx) => {
      const row = (
        await selectData<RetrievalRecord>(
          tx,
          "app_retrievals",
          this.workspaceId,
          "AND id=? AND run_id=?",
          [bundle.id, runId],
        )
      )[0];
      if (!row || !["running", "unknown_outcome"].includes(row.status) || row.owner !== owner)
        return;
      row.status = "succeeded";
      row.bundle = bundle;
      row.error = null;
      await this.writeRetrieval(tx, row);
      await this.settle(
        tx,
        `retrieval:${bundle.id}`,
        runId,
        "succeeded",
        bundle.reported_cost_usd,
        bundle.reported_cost_usd !== null,
        bundle,
      );
    });
  }

  private async writeRetrieval(tx: ResearchConnection, row: RetrievalRecord) {
    await tx.execute({
      sql: "UPDATE app_retrievals SET data=? WHERE workspace_id=? AND id=?",
      args: [JSON.stringify(row), this.workspaceId, row.id],
    });
  }

  async failRetrieval(
    id: string,
    owner: string,
    error: Failure,
    unknown: boolean,
    partialBundle?: RetrievalBundle,
    notDispatched = false,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const row = (
        await selectData<RetrievalRecord>(tx, "app_retrievals", this.workspaceId, "AND id=?", [id])
      )[0];
      const lateEvidence =
        row?.status === "unknown_outcome" &&
        row.bundle === null &&
        (partialBundle !== undefined || notDispatched);
      if (!row || (row.status !== "running" && !lateEvidence) || row.owner !== owner) return;
      await this.retrievalFailure(tx, row, error, unknown, partialBundle, notDispatched);
    });
  }

  private async retrievalFailure(
    tx: ResearchConnection,
    row: RetrievalRecord,
    error: Failure,
    unknown: boolean,
    partialBundle?: RetrievalBundle,
    notDispatched = false,
  ) {
    const data = await tx.execute({
      sql: "SELECT run_id FROM app_retrievals WHERE workspace_id=? AND id=?",
      args: [this.workspaceId, row.id],
    });
    const unbilled = notDispatched && partialBundle === undefined;
    row.status = unknown && !unbilled ? "unknown_outcome" : "failed";
    row.error = error;
    row.bundle = partialBundle ?? row.bundle;
    const actual = unbilled ? 0 : (partialBundle?.reported_cost_usd ?? null);
    await this.writeRetrieval(tx, row);
    await this.settle(
      tx,
      `retrieval:${row.id}`,
      String(data.rows[0]?.run_id),
      unbilled ? "not_dispatched" : row.status,
      actual,
      actual !== null,
      partialBundle ?? null,
    );
  }

  async recordToolCall(tool: string, runId?: string): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO app_tool_calls(workspace_id,tool,run_id,created_at) VALUES(?,?,?,?)",
        args: [this.workspaceId, tool, runId ?? null, this.now()],
      });
    });
  }

  async listToolCalls(runId?: string): Promise<ToolCall[]> {
    const result = await this.client.execute({
      sql: `SELECT tool,run_id,created_at FROM app_tool_calls WHERE workspace_id=? ${runId ? "AND run_id=?" : ""} ORDER BY id`,
      args: runId ? [this.workspaceId, runId] : [this.workspaceId],
    });
    return result.rows.map((row) => ({
      tool: String(row.tool),
      run_id: row.run_id === null ? null : String(row.run_id),
      created_at: String(row.created_at),
    }));
  }
}

/** Public persistence boundary usable locally or through the private Cloudflare RPC bridge. */
export type ResearchStorage = Omit<ResearchStore, "client">;
export type { ResearchClient, ResearchConnection, TransactionRunner } from "./client.js";
export type { DurableResearchStorage, DurableSqlCursor, DurableSqlValue } from "./durable-sql.js";
export { createDurableResearchStore, DurableSqlClient } from "./durable-sql.js";
export * from "./protocol.js";
