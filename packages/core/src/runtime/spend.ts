import {
  type Observation,
  type ObservationStatus,
  ResearchError,
  type RetrievalBundle,
  type SpendAuthorization,
  type Usage,
} from "../contracts.js";
import type { ProviderRegistry } from "../providers/types.js";
import { retrievalEstimate } from "../targets.js";
import type { RuntimeOptions } from "./types.js";

const delivering = new WeakMap<RuntimeOptions, Promise<void>>();

async function deliverPending(
  options: RuntimeOptions,
  attempt?: SpendAuthorization,
): Promise<void> {
  const { store } = options;
  if (!store.listPendingSettlements || !store.ackSettlement) return;
  const ack = store.ackSettlement.bind(store);
  const events = await store.listPendingSettlements(10, attempt);
  // Independent attempts run together so a hung callback cannot hold the whole batch.
  await Promise.all(
    events.map(async (event) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const configured = options.settlementTimeoutMs ?? 10_000;
        const timeout = Number.isFinite(configured)
          ? Math.max(1, Math.min(configured, 10_000))
          : 10_000;
        await Promise.race([
          Promise.resolve().then(() =>
            options.hooks?.settled?.(event.attempt, event.outcome, event.usage, event.revision),
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new ResearchError(
                    "settlement_timeout",
                    "Settlement delivery exceeded its deadline",
                  ),
                ),
              timeout,
            );
          }),
        ]);
        await ack(event.id);
      } catch (error) {
        try {
          await store.deferSettlement?.(event.id);
        } catch (deferError) {
          reportError(options, deferError);
        }
        reportError(options, error);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** Retry committed settlement evidence without reexecuting any paid operation. */
export async function drainSettlements(
  options: RuntimeOptions,
  attempt?: SpendAuthorization,
): Promise<void> {
  if (!options.store.listPendingSettlements || !options.store.ackSettlement) return;
  if (attempt)
    return deliverPending(options, attempt).catch((error) => reportError(options, error));
  const active = delivering.get(options);
  if (active) {
    return active;
  }
  const delivery = deliverPending(options, attempt).catch((error) => reportError(options, error));
  delivering.set(options, delivery);
  try {
    await delivery;
  } finally {
    delivering.delete(options);
  }
}

/** Build a shared-retrieval spend request using the configured adapter estimate. */
export function retrievalAuthorization(
  observation: Observation,
  id: string,
  providers?: ProviderRegistry,
): SpendAuthorization {
  return {
    workspace_id: observation.workspace_id,
    run_id: observation.run_id,
    observation_id: observation.id,
    attempt_id: id,
    operation: "retrieval",
    estimated_cost_usd: retrievalEstimate(
      observation.target,
      observation.prompt.queries ?? [observation.prompt.text],
      providers,
    ),
  };
}

/** Represent retrieval settlement, or known zero usage when no request was dispatched. */
export function retrievalUsage(bundle?: RetrievalBundle): Usage {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_tokens: null,
    search_requests: bundle?.queries.length ?? 0,
    reported_cost_usd: bundle ? bundle.reported_cost_usd : 0,
    estimated_cost_usd: bundle?.estimated_cost_usd ?? 0,
    raw: {},
  };
}

/** Return explicit zero usage for an operation confirmed never to have been dispatched. */
export function undispatchedUsage(): Usage {
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

/** Run the host spend gate and convert unexpected failures into a safe denial. */
export async function authorizeSpend(
  options: RuntimeOptions,
  attempt: SpendAuthorization,
): Promise<void> {
  try {
    await options.hooks?.authorize?.(attempt);
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError("authorization_denied", "Spend authorization was denied");
  }
}

/** Report background failures without allowing a host callback to break settlement. */
export function reportError(options: RuntimeOptions, error: unknown): void {
  try {
    options.onError?.(error);
  } catch {
    return;
  }
}

/** Notify the host of settlement while retaining runtime progress if reporting fails. */
export async function settleSpend(
  options: RuntimeOptions,
  attempt: SpendAuthorization,
  outcome: ObservationStatus,
  usage: Usage | null,
): Promise<void> {
  if (options.store.listPendingSettlements && options.store.ackSettlement) {
    await drainSettlements(options, attempt);
    return;
  }
  try {
    await options.hooks?.settled?.(attempt, outcome, usage);
  } catch (error) {
    reportError(options, error);
  }
}
