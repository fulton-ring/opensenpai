import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  type Observation,
  ResearchError,
  type ResultQuery,
  type RunEstimate,
  type RunInput,
  type RunRecord,
  runInputSchema,
  type Target,
  targetSchema,
} from "./contracts.js";
import { defaultProviders } from "./providers/index.js";
import type { ProviderRegistry } from "./providers/types.js";
import { canonical } from "./storage/records.js";
import { estimateRun, targetAvailability } from "./targets.js";

/** Optional provider catalog query; omitting it lists configured adapters without network requests. */
export interface TargetDiscoveryQuery {
  provider?: string;
  model_query?: string;
  limit?: number;
}
/** Workspace run filters and opaque pagination cursor accepted by the persistence boundary. */
export interface RunPageQuery {
  project?: string;
  limit?: number;
  before?: string;
  cursor?: string;
}
/** Durable, workspace-scoped run operations required by MCP research tools and their audit trail. */
export interface ServiceStore {
  createRun(
    input: RunInput,
    targets: Target[],
    estimate: RunEstimate,
  ): Promise<{ run: RunRecord; created: boolean }>;
  getRun(id: string): Promise<RunRecord | null>;
  getRunByIdempotencyKey(key: string): Promise<RunRecord | null>;
  listUnqueued(limit?: number, runId?: string): Promise<Observation[]>;
  listRuns(query?: RunPageQuery): Promise<RunRecord[]>;
  listRunPage(query?: RunPageQuery): Promise<{ runs: RunRecord[]; next_cursor: string | null }>;
  getResults(
    query: ResultQuery,
  ): Promise<{ observations: Observation[]; next_cursor: number | null }>;
  cancelRun(id: string): Promise<RunRecord | null>;
  recordToolCall(tool: string, runId?: string): Promise<void>;
}
/** Execution boundary for submitting accepted observations and propagating run cancellation. */
export interface ServiceRuntime {
  dispatch(observations: Observation[]): Promise<void>;
  cancel(runId: string): Promise<void>;
}
/** Trusted operator configuration shared by run validation, pricing resolution and execution. */
export interface ServiceOptions {
  store: ServiceStore;
  runtime: ServiceRuntime;
  targets: Target[];
  providers?: ProviderRegistry;
  env: Record<string, string | undefined>;
  dispatchMode?: "native" | "external";
  authorizeRun?: (estimate: RunEstimate) => Promise<void>;
}
const terminal = (run: RunRecord) => !["queued", "running"].includes(run.status);

/** Validates agent research requests, resolves provider metadata and persists accepted work before dispatch. */
export class ResearchService {
  constructor(readonly options: ServiceOptions) {}

  private modelProvider(id: string) {
    const providers = this.options.providers ?? defaultProviders;
    const provider = Object.hasOwn(providers.models, id) ? providers.models[id] : undefined;
    if (!provider)
      throw new ResearchError(
        "UNKNOWN_MODEL_PROVIDER",
        `Unknown model provider '${id}'. Call list_targets to discover providers.`,
      );
    return provider;
  }

  private async selected(input: RunInput): Promise<Target[]> {
    const selected = input.targets.map((selection) => {
      if (typeof selection !== "string") {
        const { provider, serving_provider, ...value } = selection;
        const adapter = this.modelProvider(provider);
        const target = targetSchema.parse({
          ...value,
          transport: provider,
          ...(serving_provider ? { provider_options: { provider: serving_provider } } : {}),
        });
        return { target, adapter };
      }
      const target = this.options.targets.find((item) => item.id === selection);
      if (!target)
        throw new ResearchError(
          "UNKNOWN_TARGET",
          `Unknown target '${selection}'. Call list_targets for configured target IDs, or supply an inline model and search selection.`,
        );
      return { target, adapter: undefined };
    });
    return Promise.all(
      selected.map(async ({ target, adapter }) => {
        if (!adapter?.resolveTarget) return target;
        const resolved = targetSchema.parse(
          await adapter.resolveTarget(structuredClone(target), { env: this.options.env, fetch }),
        );
        if (
          !isDeepStrictEqual(
            { ...target, pricing: undefined, provider_options: undefined },
            { ...resolved, pricing: undefined, provider_options: undefined },
          ) ||
          (target.provider_options?.provider !== undefined &&
            resolved.provider_options?.provider !== target.provider_options.provider)
        )
          throw new ResearchError(
            "INVALID_TARGET_RESOLUTION",
            "Model metadata resolver changed the requested configuration or explicit serving provider",
          );
        return resolved;
      }),
    );
  }

  private async discoverModels(query: TargetDiscoveryQuery) {
    if (query.provider === undefined && query.model_query === undefined) return {};
    const providers = this.options.providers ?? defaultProviders;
    const id =
      query.provider ?? (Object.hasOwn(providers.models, "openrouter") ? "openrouter" : undefined);
    if (!id)
      throw new ResearchError(
        "MODEL_PROVIDER_REQUIRED",
        "Select a model provider to search its model catalog",
      );
    const provider = this.modelProvider(id);
    if (!provider.listModels)
      throw new ResearchError(
        "MODEL_DISCOVERY_UNAVAILABLE",
        `Provider '${id}' does not expose a model catalog`,
      );
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new ResearchError(
        "INVALID_DISCOVERY_QUERY",
        "Model discovery limit must be between 1 and 50",
      );
    return {
      model_provider: id,
      models: await provider.listModels(
        { query: query.model_query, limit },
        { env: this.options.env, fetch },
      ),
    };
  }

  /** Discover adapters, optional model metadata and recent observed capabilities; never generates text. */
  async listTargets(query: TargetDiscoveryQuery = {}) {
    await this.options.store.recordToolCall("list_targets");
    const models = await this.discoverModels(query);
    const observed = await this.observedCapabilities();
    const providers = this.options.providers ?? defaultProviders;
    return {
      model_providers: Object.keys(providers.models),
      retrieval_providers: Object.keys(providers.retrievals),
      ...models,
      observed_sample_scope: "last_10_runs",
      targets: this.options.targets.map((target) => ({
        ...target,
        ...targetAvailability(target, this.options.env, this.options.providers),
        observed_capabilities: observed.get(target.id) ?? null,
      })),
    };
  }

  /** Resolve inline selections and estimate their bounded cost without accepting or dispatching paid work. */
  async estimateRun(value: unknown) {
    await this.options.store.recordToolCall("estimate_run");
    const input = runInputSchema.parse(value);
    return estimateRun(input, await this.selected(input), this.options.providers);
  }

  /** Validate availability and budget, persist an idempotent run, then submit its pending observations. */
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
    const prior = await this.options.store.getRunByIdempotencyKey(input.idempotency_key);
    if (prior) {
      if (canonical(prior.input) !== canonical(input))
        throw new ResearchError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key already has a different input",
        );
      return { run: prior, created: false };
    }
    const targets = await this.selected(input);
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
    await this.options.authorizeRun?.(estimate);
    return this.options.store.createRun(input, targets, estimate);
  }

  /** Read a workspace run, optionally waiting briefly for its persisted state to change. */
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

  /** Return paginated durable observations; raw provider evidence is omitted unless explicitly requested. */
  async getResults(query: ResultQuery) {
    await this.options.store.recordToolCall("get_results", query.run_id);
    await this.requireRun(query.run_id);
    return this.options.store.getResults({
      ...query,
      include_raw: query.include_raw ?? false,
      limit: query.limit ?? 25,
    });
  }

  /** List workspace runs using the store's stable opaque pagination cursor. */
  async listRuns(query: RunPageQuery = {}) {
    await this.options.store.recordToolCall("list_runs");
    return this.options.store.listRunPage({ ...query, limit: query.limit ?? 25 });
  }

  /** Persist cancellation before signalling active execution; upstream cancellation remains best effort. */
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
