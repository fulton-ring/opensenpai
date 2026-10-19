import { defaultProviders } from "../providers/index.js";
import { reportError } from "./spend.js";
import type { RuntimeOptions } from "./types.js";

/** Repair missing cost using metadata only; leases and backoff survive process restarts. */
export async function reconcilePendingUsage(options: RuntimeOptions): Promise<void> {
  const { store } = options;
  if (
    !store.listPendingUsageReconciliations ||
    !store.claimUsageReconciliation ||
    !store.finishUsageReconciliation
  )
    return;
  const owner = crypto.randomUUID();
  const models = (options.providers ?? defaultProviders).models;
  for (const observation of await store.listPendingUsageReconciliations(5)) {
    if (
      !observation.attempt_id ||
      !(await store.claimUsageReconciliation(observation.attempt_id, owner))
    )
      continue;
    let usage = null;
    try {
      const provider = Object.hasOwn(models, observation.target.transport)
        ? models[observation.target.transport]
        : undefined;
      if (observation.result && provider?.reconcileUsage) {
        // Metadata adapters must not generate; a deadline prevents one adapter stalling repair.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          usage = await Promise.race([
            provider.reconcileUsage(observation.target, observation.result, {
              env: options.env,
              fetch: globalThis.fetch,
            }),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      reportError(options, error);
    }
    await store.finishUsageReconciliation(observation.id, owner, usage);
  }
}
