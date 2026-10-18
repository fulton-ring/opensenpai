import { setTimeout as delay } from "node:timers/promises";
import {
  type Observation,
  ResearchError,
  type ResultQuery,
  type RunEstimate,
  type RunInput,
  type RunRecord,
  runInputSchema,
  type Target,
} from "./contracts.js";
import type { ProviderRegistry } from "./providers/types.js";
import { estimateRun, targetAvailability } from "./targets.js";

export interface RunPageQuery {
  project?: string;
  limit?: number;
  before?: string;
  cursor?: string;
}
export interface ServiceStore {
  createRun(
    input: RunInput,
    targets: Target[],
    estimate: RunEstimate,
  ): Promise<{ run: RunRecord; created: boolean }>;
  getRun(id: string): Promise<RunRecord | null>;
  listUnqueued(limit?: number, runId?: string): Promise<Observation[]>;
  listRuns(query?: RunPageQuery): Promise<RunRecord[]>;
  listRunPage(query?: RunPageQuery): Promise<{ runs: RunRecord[]; next_cursor: string | null }>;
  getResults(
    query: ResultQuery,
  ): Promise<{ observations: Observation[]; next_cursor: number | null }>;
  cancelRun(id: string): Promise<RunRecord | null>;
  recordToolCall(tool: string, runId?: string): Promise<void>;
}
export interface ServiceRuntime {
  dispatch(observations: Observation[]): Promise<void>;
  cancel(runId: string): Promise<void>;
}
export interface ServiceOptions {
  store: ServiceStore;
  runtime: ServiceRuntime;
  targets: Target[];
  providers?: ProviderRegistry;
  env: Record<string, string | undefined>;
  dispatchMode?: "native" | "external";
}
const terminal = (run: RunRecord) => !["queued", "running"].includes(run.status);

export class ResearchService {
  constructor(readonly options: ServiceOptions) {}

  private selected(input: RunInput): Target[] {
    return input.targets.map((id) => {
      const target = this.options.targets.find((item) => item.id === id);
      if (!target)
        throw new ResearchError(
          "UNKNOWN_TARGET",
          `Unknown target '${id}'. Call list_targets for configured target IDs.`,
        );
      return target;
    });
  }

  async listTargets() {
    await this.options.store.recordToolCall("list_targets");
    const observed = await this.observedCapabilities();
    return {
      observed_sample_scope: "last_10_runs",
      targets: this.options.targets.map((target) => ({
        ...target,
        ...targetAvailability(target, this.options.env, this.options.providers),
        observed_capabilities: observed.get(target.id) ?? null,
      })),
    };
  }

  async estimateRun(value: unknown) {
    await this.options.store.recordToolCall("estimate_run");
    const input = runInputSchema.parse(value);
    return estimateRun(input, this.selected(input), this.options.providers);
  }

  async startRun(value: unknown) {
    const saved = await this.createValidatedRun(value).catch(async (error: unknown) => {
      await this.options.store.recordToolCall("start_run");
      throw error;
    });
    await this.options.store.recordToolCall("start_run", saved.run.id);
    if (!terminal(saved.run) && this.options.dispatchMode !== "external") {
      const pending = await this.options.store.listUnqueued(100, saved.run.id);
      if (pending.length) await this.options.runtime.dispatch(pending);
    }
    return saved;
  }

  private async createValidatedRun(value: unknown) {
    const input = runInputSchema.parse(value);
    const targets = this.selected(input);
    for (const target of targets) {
      const availability = targetAvailability(target, this.options.env, this.options.providers);
      if (!availability.available)
        throw new ResearchError(
          "TARGET_UNAVAILABLE",
          `Target '${target.id}' is unavailable. ${availability.reason ?? "Configure its provider credentials before retrying."}`,
        );
    }
    const estimate = estimateRun(input, targets, this.options.providers);
    if (input.max_estimated_cost_usd !== undefined) {
      if (estimate.estimated_cost_usd === null || estimate.unpriced_targets.length)
        throw new ResearchError(
          "UNPRICED_TARGET",
          "Cannot enforce a budget with unpriced targets. Configure pricing or choose priced targets.",
        );
      if (estimate.estimated_cost_usd > input.max_estimated_cost_usd)
        throw new ResearchError(
          "BUDGET_EXCEEDED",
          "Estimated run cost exceeds max_estimated_cost_usd. Reduce observations or increase the budget.",
        );
    }
    return this.options.store.createRun(input, targets, estimate);
  }

  async getRun({
    run_id,
    wait_ms = 1_000,
  }: {
    run_id: string;
    wait_ms?: number;
  }): Promise<RunRecord> {
    await this.options.store.recordToolCall("get_run", run_id);
    let run = await this.requireRun(run_id);
    const initial = JSON.stringify(run);
    const deadline = Date.now() + Math.min(10_000, Math.max(0, wait_ms));
    while (!terminal(run) && Date.now() < deadline) {
      await delay(Math.min(100, deadline - Date.now()));
      run = await this.requireRun(run_id);
      if (JSON.stringify(run) !== initial) break;
    }
    return run;
  }

  async getResults(query: ResultQuery) {
    await this.options.store.recordToolCall("get_results", query.run_id);
    await this.requireRun(query.run_id);
    return this.options.store.getResults({
      ...query,
      include_raw: query.include_raw ?? false,
      limit: query.limit ?? 25,
    });
  }

  async listRuns(query: RunPageQuery = {}) {
    await this.options.store.recordToolCall("list_runs");
    return this.options.store.listRunPage({ ...query, limit: query.limit ?? 25 });
  }

  async cancelRun({ run_id }: { run_id: string }) {
    await this.options.store.recordToolCall("cancel_run", run_id);
    const run = await this.options.store.cancelRun(run_id);
    if (!run)
      throw new ResearchError(
        "RUN_NOT_FOUND",
        "Run not found. Call list_runs to find an accessible run ID.",
      );
    await this.options.runtime.cancel(run_id);
    return run;
  }

  private async observedCapabilities() {
    const runs = await this.options.store.listRuns({ limit: 10 });
    const pages = await Promise.all(
      runs.map((run) =>
        this.options.store.getResults({ run_id: run.id, limit: 100, include_raw: false }),
      ),
    );
    const observations = pages
      .flatMap((page) => page.observations)
      .filter((item) => item.result)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const observed = new Map<
      string,
      {
        model: string;
        serving_provider: string | null;
        search_activity: NonNullable<Observation["result"]>["search_activity"];
        citation_count: number;
        source_count: number;
        observed_at: string;
      }
    >();
    for (const observation of observations) {
      const result = observation.result;
      if (!result || observed.has(observation.target.id)) continue;
      observed.set(observation.target.id, {
        model: result.model,
        serving_provider: result.serving_provider,
        search_activity: result.search_activity,
        citation_count: result.citations.length,
        source_count: result.sources.length,
        observed_at: observation.updated_at,
      });
    }
    return observed;
  }

  private async requireRun(id: string) {
    const run = await this.options.store.getRun(id);
    if (!run)
      throw new ResearchError(
        "RUN_NOT_FOUND",
        "Run not found. Call list_runs to find an accessible run ID.",
      );
    return run;
  }
}
