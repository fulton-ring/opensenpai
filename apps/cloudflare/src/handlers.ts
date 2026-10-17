/** The ingress speaks HTTP to the native Node application; provider execution stays in Containers. */
export interface DeploymentEnvironment {
  MCP_AUTH_TOKEN: string;
  INTERNAL_EXECUTION_TOKEN: string;
  APPLICATION: { fetch(request: Request): Promise<Response> };
  OBSERVATIONS: { send(body: { observationId: string }): Promise<unknown> };
}

interface Delivery {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds: number }): void;
}

function internalRequest(env: DeploymentEnvironment, path: string, method = "POST"): Request {
  return new Request(`http://container/internal/observations/${path}`, {
    method,
    headers: { authorization: `Bearer ${env.INTERNAL_EXECUTION_TOKEN}` },
    signal: AbortSignal.timeout(120_000),
  });
}

function observationId(body: unknown): string {
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).length !== 1 ||
    !("observationId" in body) ||
    typeof body.observationId !== "string" ||
    !body.observationId.trim() ||
    body.observationId.length > 256
  ) {
    throw new Error("Queue message must contain only an observationId");
  }
  return body.observationId;
}

export async function consumeObservations(
  batch: { messages: readonly Delivery[] },
  env: DeploymentEnvironment,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const id = observationId(message.body);
      const response = await env.APPLICATION.fetch(
        internalRequest(env, `${encodeURIComponent(id)}/execute`),
      );
      // The application only returns 2xx after durable terminal state, including duplicate delivery.
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`Execution incomplete: ${response.status}`);
      message.ack();
    } catch {
      // Cloudflare moves messages to the configured DLQ after max_retries; never discard failures.
      message.retry({ delaySeconds: 30 });
    }
  }
}

export async function dispatchOutbox(env: DeploymentEnvironment): Promise<void> {
  const response = await env.APPLICATION.fetch(internalRequest(env, "outbox", "GET"));
  if (!response.ok) throw new Error(`Outbox unavailable: ${response.status}`);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("observations" in body) ||
    !Array.isArray(body.observations)
  ) {
    throw new Error("Invalid outbox response");
  }
  for (const item of body.observations.slice(0, 50)) {
    const id = observationId({ observationId: item?.id });
    await env.OBSERVATIONS.send({ observationId: id });
    const marked = await env.APPLICATION.fetch(
      internalRequest(env, `${encodeURIComponent(id)}/queued`),
    );
    if (!marked.ok) throw new Error(`Outbox mark failed: ${marked.status}`);
    await marked.arrayBuffer();
  }
}

export async function handleRequest(
  request: Request,
  env: DeploymentEnvironment,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health" || pathname === "/ready") return env.APPLICATION.fetch(request);
  if (pathname !== "/mcp") return new Response("Not found", { status: 404 });
  if (
    !env.MCP_AUTH_TOKEN ||
    request.headers.get("authorization") !== `Bearer ${env.MCP_AUTH_TOKEN}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const response = await env.APPLICATION.fetch(request);
  if (request.method === "POST") {
    try {
      await dispatchOutbox(env);
    } catch {
      // Accepted observations remain durable; the repair Cron retries dispatch independently.
      return Response.json(
        { error: "Queue unavailable; accepted work is persisted for retry" },
        { status: 503 },
      );
    }
  }
  return response;
}

export function applicationEnvironment(bindings: Record<string, unknown>): Record<string, string> {
  const databaseUrl = bindings.DATABASE_URL;
  if (typeof databaseUrl !== "string" || !/^(libsql|https?):\/\//.test(databaseUrl)) {
    throw new Error(
      "Cloudflare requires a remote libSQL DATABASE_URL; container disk is ephemeral",
    );
  }
  if (!bindings.MCP_AUTH_TOKEN || !bindings.INTERNAL_EXECUTION_TOKEN) {
    throw new Error("MCP_AUTH_TOKEN and INTERNAL_EXECUTION_TOKEN secrets are required");
  }
  // String bindings include arbitrary target api_key_env names without forwarding service bindings.
  const values = Object.fromEntries(
    Object.entries(bindings).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    ...values,
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    MCP_ALLOWED_HOSTS: [
      ...new Set([
        "localhost",
        "127.0.0.1",
        "container",
        ...(values.MCP_ALLOWED_HOSTS?.split(",") ?? []),
      ]),
    ].join(","),
    OBSERVATION_DISPATCH_MODE: "external",
  };
}
