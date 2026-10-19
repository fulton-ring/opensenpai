import { Container, getContainer } from "@cloudflare/containers";
import { createDurableResearchStore } from "@opensenpai/core/storage";

export { ContainerProxy } from "@cloudflare/containers";

import {
  applicationEnvironment,
  consumeObservations,
  dispatchOutbox,
  handleRequest,
} from "./handlers.js";
import { createResearchRpc, handlePrivateStorage } from "./private-storage.js";

interface Environment extends Record<string, unknown> {
  APPLICATION: DurableObjectNamespace<OpenSenpaiContainer>;
  OBSERVATIONS: Queue<{ observationId: string }>;
  MCP_AUTH_TOKEN: string;
  INTERNAL_EXECUTION_TOKEN: string;
  WORKSPACE_ID: string;
  DB: D1Database;
}

/** Host the Node runtime and own its transactional research storage across restarts. */
export class OpenSenpaiContainer extends Container<Environment> {
  defaultPort = 4111;
  sleepAfter = "5m";
  enableInternet = true;
  entrypoint = [
    "node",
    "apps/server/dist/cli.js",
    "--role",
    "api",
    "--transport",
    "http",
    "--port",
    "4111",
  ];
  envVars = applicationEnvironment(this.env);
  private readonly research = createResearchRpc(
    createDurableResearchStore(this.ctx.storage, this.env.WORKSPACE_ID),
  );

  // RPC is reachable only through the namespace binding; public fetch does not route it.
  researchRpc(body: unknown) {
    return this.research(body);
  }

  /** Inspect durable repair work without starting the Node process. */
  async needsRepair(): Promise<boolean> {
    const recovered = await this.researchRpc({ method: "recoverExpired", args: [] });
    if ("error" in recovered) throw new Error("Durable lease recovery failed");
    for (const method of [
      "listUnqueued",
      "listPendingSettlements",
      "listPendingUsageReconciliations",
    ] as const) {
      const pending = await this.researchRpc({ method, args: [1] });
      if ("error" in pending || !Array.isArray(pending.result))
        throw new Error("Durable repair lookup failed");
      if (pending.result.length) return true;
    }
    return false;
  }
}

OpenSenpaiContainer.outboundByHost = { "cloudflare-storage": handlePrivateStorage };

function environment(env: Environment) {
  return { ...env, APPLICATION: getContainer(env.APPLICATION, "opensenpai") };
}

/** Worker ingress, queue consumption, and dispatch repair for the standalone research service. */
export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    return handleRequest(request, environment(env));
  },
  queue(batch: MessageBatch<unknown>, env: Environment): Promise<void> {
    return consumeObservations(batch, environment(env));
  },
  // Repairs dispatch of already accepted jobs only. It never starts scheduled research.
  async scheduled(_controller: ScheduledController, env: Environment): Promise<void> {
    const deployment = environment(env);
    if (await deployment.APPLICATION.needsRepair()) await dispatchOutbox(deployment, true);
  },
};
