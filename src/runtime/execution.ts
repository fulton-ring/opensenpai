import { createHash } from "node:crypto";
import {
  type Failure,
  type Observation,
  type ProviderResult,
  ResearchError,
  type RetrievalBundle,
  type SpendAuthorization,
} from "../contracts.js";
import { EXA_ESTIMATED_COST_PER_QUERY } from "../targets.js";
import type { RuntimeOptions } from "./types.js";

const safeBeforeDispatch = new Set([
  "missing_credentials",
  "invalid_credentials",
  "missing_retrieval",
  "invalid_retrieval",
  "unsupported_configuration",
]);
function knownRejection(error: unknown): boolean {
  return (
    error instanceof ResearchError &&
    (safeBeforeDispatch.has(error.code) ||
      /^provider_http_(400|401|403|404|429)$/.test(error.code) ||
      error.code === "provider_failed" ||
      error.code === "provider_cancelled")
  );
}
function responseFromError(error: unknown): ProviderResult | null {
  return error instanceof ResearchError && "result" in error
    ? (error.result as ProviderResult)
    : null;
}
function failure(error: unknown): Failure {
  if (error instanceof ResearchError)
    return { code: error.code, message: error.message, retryable: false };
  return {
    code: "execution_error",
    message: error instanceof Error ? error.message : "Execution failed",
    retryable: false,
  };
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export function retrievalId(observation: Observation): string {
  return `retrieval_${createHash("sha256")
    .update(
      JSON.stringify({
        run: observation.run_id,
        prompt: observation.prompt,
        repetition: observation.repetition,
        search: observation.target.search,
        locale: observation.locale,
      }),
    )
    .digest("hex")}`;
}
interface Attempt {
  observation: Observation;
  authorization: SpendAuthorization;
  controller: AbortController;
  dispatched: boolean;
  result: ProviderResult | null;
  terminal: Observation["status"];
  providerCall?: Promise<ProviderResult>;
}
export class ObservationExecutor {
  private readonly active = new Map<string, Attempt>();
  private stopped = false;
  constructor(
    private readonly options: RuntimeOptions,
    private readonly owner: string,
  ) {}
  cancel(runId: string) {
    for (const item of this.active.values())
      if (item.observation.run_id === runId)
        item.controller.abort(new ResearchError("cancelled", "Run was cancelled"));
  }
  stop() {
    this.stopped = true;
    for (const item of this.active.values())
      item.controller.abort(new ResearchError("runtime_stopped", "Runtime stopped"));
  }
  async execute(id: string, workflowSignal: AbortSignal): Promise<{ id: string }> {
    if ((this.options.role === "api" && this.options.dispatchMode !== "external") || this.stopped)
      return { id };
    const observation = await this.options.store.claim(id, this.owner, 150_000);
    if (!observation?.attempt_id) return { id };
    const attempt: Attempt = {
      observation,
      authorization: {
        workspace_id: observation.workspace_id,
        run_id: observation.run_id,
        observation_id: id,
        attempt_id: observation.attempt_id,
        estimated_cost_usd: observation.estimated_cost_usd,
      },
      controller: new AbortController(),
      dispatched: false,
      result: null,
      terminal: "failed",
    };
    this.active.set(id, attempt);
    const cleanup = this.monitor(attempt, workflowSignal);
    try {
      await this.run(attempt);
    } catch (error) {
      await this.persistFailure(attempt, error);
    } finally {
      cleanup();
      this.active.delete(id);
    }
    await this.options.hooks?.settled?.(
      attempt.authorization,
      attempt.terminal,
      attempt.result?.usage ?? null,
    );
    this.preserveLateResult(attempt);
    return { id };
  }
  private monitor(attempt: Attempt, workflowSignal: AbortSignal) {
    const { controller, observation } = attempt;
    const abort = () => controller.abort(workflowSignal.reason);
    workflowSignal.addEventListener("abort", abort, { once: true });
    if (workflowSignal.aborted) abort();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new ResearchError("deadline_exceeded", "Observation exceeded its execution deadline"),
        ),
      Math.min(120_000, this.options.timeoutMs ?? observation.target.timeout_ms),
    );
    let polling = false;
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      void this.options.store
        .getRun(observation.run_id)
        .then((run) => {
          if (run?.cancel_requested)
            controller.abort(new ResearchError("cancelled", "Run was cancelled"));
        })
        .catch((error) => controller.abort(error))
        .finally(() => {
          polling = false;
        });
    }, this.options.cancellationPollMs ?? 500);
    return () => {
      clearTimeout(timeout);
      clearInterval(poll);
      workflowSignal.removeEventListener("abort", abort);
    };
  }
  private async check(attempt: Attempt) {
    attempt.controller.signal.throwIfAborted();
    if ((await this.options.store.getRun(attempt.observation.run_id))?.cancel_requested)
      throw new ResearchError("cancelled", "Run was cancelled");
  }
  private async run(attempt: Attempt) {
    const { observation, authorization, controller } = attempt;
    await this.check(attempt);
    const retrieval = await this.retrieve(observation, controller.signal);
    await this.check(attempt);
    await bounded(
      this.options.hooks?.authorize?.(authorization) ?? Promise.resolve(),
      controller.signal,
    );
    await this.check(attempt);
    if (!(await this.options.store.markDispatched(observation.id, authorization.attempt_id)))
      throw new ResearchError("cancelled", "Dispatch was cancelled or ownership was lost");
    attempt.dispatched = true;
    const execute =
      this.options.executeProvider ?? (await import("../providers/index.js")).executeProvider;
    controller.signal.throwIfAborted();
    const providerCall: Promise<ProviderResult> = execute(
      {
        observation_id: observation.id,
        prompt: observation.prompt,
        target: observation.target,
        locale: observation.locale,
        retrieval,
        signal: controller.signal,
      },
      this.options.env,
    );
    attempt.providerCall = providerCall;
    attempt.result = await bounded(providerCall, controller.signal);
    await this.options.store.succeed(observation.id, authorization.attempt_id, attempt.result);
    attempt.terminal = "succeeded";
  }
  private async persistFailure(attempt: Attempt, error: unknown) {
    const known = knownRejection(error);
    const cancelled = error instanceof ResearchError && error.code === "cancelled";
    attempt.terminal =
      attempt.dispatched && !known ? "unknown_outcome" : cancelled ? "cancelled" : "failed";
    attempt.result = responseFromError(error);
    await this.options.store.fail(
      attempt.observation.id,
      attempt.authorization.attempt_id,
      failure(error),
      attempt.terminal,
      attempt.result ?? undefined,
    );
  }
  private preserveLateResult(attempt: Attempt) {
    if (!attempt.providerCall || attempt.result || !attempt.controller.signal.aborted) return;
    // Abort is best effort; successful late responses still carry incurred cost.
    void attempt.providerCall
      .then(
        async (late) => {
          await this.options.store.succeed(
            attempt.observation.id,
            attempt.authorization.attempt_id,
            late,
          );
          await this.options.hooks?.settled?.(attempt.authorization, "succeeded", late.usage);
        },
        async (error) => {
          if (!responseFromError(error)) return;
          await this.persistFailure(attempt, error);
          await this.options.hooks?.settled?.(
            attempt.authorization,
            attempt.terminal,
            attempt.result?.usage ?? null,
          );
        },
      )
      .catch((error) => this.options.onError?.(error));
  }
  private async retrieve(
    observation: Observation,
    signal: AbortSignal,
  ): Promise<RetrievalBundle | undefined> {
    if (observation.target.search.mode !== "controlled") return undefined;
    const { store } = this.options;
    const id = retrievalId(observation);
    await store.setRetrieval?.(observation.id, id);
    if (
      (await store.getRetrieval(id)) ||
      !(await store.claimRetrieval(
        id,
        observation.run_id,
        this.owner,
        150_000,
        (observation.prompt.queries?.length ?? 1) * EXA_ESTIMATED_COST_PER_QUERY,
      ))
    )
      return this.waitForRetrieval(id, signal);
    return this.fetchRetrieval(observation, id, signal);
  }
  private async fetchRetrieval(
    observation: Observation,
    id: string,
    signal: AbortSignal,
  ): Promise<RetrievalBundle> {
    const { store } = this.options;
    const search = observation.target.search;
    if (search.mode !== "controlled")
      throw new ResearchError("invalid_retrieval", "Controlled search is required");
    let call: Promise<RetrievalBundle> | undefined;
    try {
      const retrieve =
        this.options.retrieveExa ?? (await import("../providers/index.js")).retrieveExa;
      signal.throwIfAborted();
      call = retrieve(
        {
          id,
          queries: observation.prompt.queries ?? [observation.prompt.text],
          max_results: search.max_results,
          max_characters: search.max_characters,
          signal,
        },
        this.options.env,
      );
      const bundle = await bounded(call, signal);
      await store.finishRetrieval(bundle, this.owner, observation.run_id);
      return bundle;
    } catch (error) {
      await store.failRetrieval(id, this.owner, failure(error), !knownRejection(error));
      if (call && signal.aborted)
        void call
          .then((bundle) => store.finishRetrieval(bundle, this.owner, observation.run_id))
          .catch((error) => this.options.onError?.(error));
      throw error;
    }
  }
  private async waitForRetrieval(id: string, signal: AbortSignal): Promise<RetrievalBundle> {
    while (true) {
      signal.throwIfAborted();
      const record = await this.options.store.getRetrieval(id);
      if (record?.status === "succeeded" && record.bundle) return record.bundle;
      if (record?.status === "failed" || record?.status === "unknown_outcome")
        throw new ResearchError(
          "retrieval_unavailable",
          "Shared retrieval did not complete successfully",
        );
      await bounded(new Promise((resolve) => setTimeout(resolve, 25)), signal);
    }
  }
}
