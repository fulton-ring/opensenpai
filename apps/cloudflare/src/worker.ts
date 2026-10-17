import { Container, getContainer } from "@cloudflare/containers";
import {
  applicationEnvironment,
  consumeObservations,
  dispatchOutbox,
  handleRequest,
} from "./handlers.js";

interface Environment extends Record<string, unknown> {
  APPLICATION: DurableObjectNamespace<OpenSenpaiContainer>;
  OBSERVATIONS: Queue<{ observationId: string }>;
  MCP_AUTH_TOKEN: string;
  INTERNAL_EXECUTION_TOKEN: string;
  DATABASE_URL: string;
}

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
}

function environment(env: Environment) {
  return { ...env, APPLICATION: getContainer(env.APPLICATION, "opensenpai") };
}

export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    return handleRequest(request, environment(env));
  },
  queue(batch: MessageBatch<unknown>, env: Environment): Promise<void> {
    return consumeObservations(batch, environment(env));
  },
  // Repairs dispatch of already accepted jobs only. It never starts scheduled research.
  scheduled(_controller: ScheduledController, env: Environment): Promise<void> {
    return dispatchOutbox(environment(env));
  },
};
