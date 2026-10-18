import { randomUUID } from "node:crypto";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { createWorkflow as createEventedWorkflow } from "@mastra/core/workflows/evented";
import { LibSQLStore } from "@mastra/libsql";
import { ValkeyStreamsPubSub } from "@mastra/valkey-streams";
import { z } from "zod";
import { type Observation, ResearchError } from "../contracts.js";
import { ObservationExecutor } from "./execution.js";
import { drainSettlements } from "./spend.js";
import type { RuntimeOptions } from "./types.js";

export { retrievalId } from "./execution.js";
export type { RuntimeOptions, RuntimeStore } from "./types.js";

function workflows(executor: ObservationExecutor) {
  const schema = z.object({ id: z.string() });
  // One paid boundary per native step: redelivery must first win a durable claim.
  const step = createStep({
    id: "execute-observation",
    inputSchema: schema,
    outputSchema: schema,
    retries: 0,
    execute: ({ inputData, abortSignal }) => executor.execute(inputData.id, abortSignal),
  });
  const config = {
    inputSchema: schema,
    outputSchema: schema,
    retryConfig: { attempts: 0, delay: 0 },
    options: { autoRestartActiveRuns: false, shouldPersistSnapshot: () => true },
  };
  return {
    observation: createEventedWorkflow({ id: "observation", ...config })
      .then(step)
      .commit(),
    observationDirect: createWorkflow({ id: "observation-direct", ...config })
      .then(step)
      .commit(),
  };
}

/** Coordinate Mastra workflows while durable storage authorizes each paid observation. */
export class Runtime {
  readonly mastra: Mastra;
  private readonly executor: ObservationExecutor;
  private readonly ownedPubsub: ValkeyStreamsPubSub | undefined;
  private started = false;
  private stopped = false;
  private repairTimer?: ReturnType<typeof setInterval>;
  private repairing?: Promise<void>;
  constructor(private readonly options: RuntimeOptions) {
    const owner = randomUUID();
    this.executor = new ObservationExecutor(options, owner);
    this.ownedPubsub =
      !options.pubsub && options.valkeyUrl
        ? new ValkeyStreamsPubSub({ url: options.valkeyUrl, reclaimIdleMs: 180_000 })
        : undefined;
    const storage =
      options.storage ??
      new LibSQLStore({
        id: `runtime-${owner}`,
        url: options.env.DATABASE_URL ?? "file:./data/opensenpai.db",
        ...(options.env.DATABASE_AUTH_TOKEN ? { authToken: options.env.DATABASE_AUTH_TOKEN } : {}),
      });
    this.mastra = new Mastra({
      logger: false,
      storage,
      pubsub: options.pubsub ?? this.ownedPubsub,
      workflows: workflows(this.executor),
      workers: options.role === "api" || options.directOnly ? false : undefined,
      recovery: { workflows: "off", durableAgents: "off" },
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.mastra.getStorage()?.init();
    if (this.options.role !== "api" || this.options.dispatchMode === "external")
      await this.options.store.recoverExpired();
    await drainSettlements(this.options);
    if (!this.options.directOnly && this.options.role !== "api")
      await this.mastra.startWorkers("orchestration");
    if (!this.options.directOnly && this.options.dispatchMode !== "external") {
      if (this.options.role === "all") await this.restoreLocalQueue();
      await this.drain();
      if (this.options.role !== "api")
        this.repairTimer = setInterval(() => {
          void this.repair();
        }, this.options.repairIntervalMs ?? 5_000);
    }
  }

  private async restoreLocalQueue() {
    if (this.options.store.resetPendingQueue) await this.options.store.resetPendingQueue();
    else await this.dispatch(await this.options.store.listPending(1000));
  }

  private async drain() {
    for (let batch = 0; batch < 10 && !this.stopped; batch++) {
      const pending = await this.options.store.listUnqueued(100);
      if (!pending.length) return;
      await this.dispatch(pending);
    }
  }

  private async repair() {
    if (this.stopped || this.repairing) return;
    this.repairing = (async () => {
      await this.options.store.recoverExpired();
      await drainSettlements(this.options);
      await this.drain();
    })();
    try {
      await this.repairing;
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.repairing = undefined;
    }
  }

  async dispatch(observations: Observation[]) {
    if (this.stopped) throw new ResearchError("runtime_stopped", "Runtime has stopped");
    if (this.options.dispatchMode === "external") return;
    for (const observation of observations) {
      if (observation.status !== "pending") continue;
      const run = await this.mastra
        .getWorkflow("observation")
        .createRun({ runId: `observation-${observation.id}-${randomUUID()}` });
      await run.startAsync({ inputData: { id: observation.id } });
      await this.options.store.markQueued(observation.id);
    }
  }

  async executeObservation(id: string) {
    if (this.options.role === "api" && this.options.dispatchMode !== "external") return;
    await this.mastra.getStorage()?.init();
    if (this.options.dispatchMode === "external") await this.options.store.recoverExpired();
    await drainSettlements(this.options);
    const run = await this.mastra.getWorkflow("observationDirect").createRun();
    const outcome = await run.start({ inputData: { id } });
    if (outcome.status === "failed") throw outcome.error;
  }

  /** Retry durable host billing delivery without dispatching or replaying provider work. */
  async retrySettlements() {
    await drainSettlements(this.options);
  }

  async cancel(runId: string) {
    await this.options.store.cancelRun(runId);
    this.executor.cancel(runId);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.repairTimer);
    this.executor.stop();
    if (this.repairing) await Promise.allSettled([this.repairing]);
    await this.mastra.shutdown({ drainTimeout: 1_000 });
    await this.ownedPubsub?.close();
  }
}
/** Create orchestration without starting workers or dispatching paid work. */
export function createRuntime(options: RuntimeOptions) {
  return new Runtime(options);
}
