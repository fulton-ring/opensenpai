/** The ingress speaks HTTP to the native Node application; provider execution stays in Containers. */
/** Bindings needed to authenticate ingress and durably dispatch accepted observations. */
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

/** Acknowledge queue deliveries only after execution reaches durable terminal state. */
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

/** Repair queue delivery for accepted work without creating or scheduling research. */
export async function dispatchOutbox(env: DeploymentEnvironment, repair = false): Promise<void> {
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
  if (repair) {
    const reconciled = await env.APPLICATION.fetch(internalRequest(env, "reconcile"));
    await reconciled.arrayBuffer();
    if (!reconciled.ok) throw new Error(`Billing reconciliation unavailable: ${reconciled.status}`);
  }
}

/** Route authenticated research requests while keeping storage and execution routes private. */
export async function handleRequest(
  request: Request,
  env: DeploymentEnvironment,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health" || pathname === "/ready") return env.APPLICATION.fetch(request);
  if (pathname !== "/mcp" && !pathname.startsWith("/api/v1/research/"))
    return new Response("Not found", { status: 404 });
  if (
    !env.MCP_AUTH_TOKEN ||
    request.headers.get("authorization") !== `Bearer ${env.MCP_AUTH_TOKEN}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const response = await env.APPLICATION.fetch(request);
  if (request.method === "POST" || request.method === "PATCH") {
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

/** Forward explicitly allowed provider credentials while retaining infrastructure bindings. */
export function applicationEnvironment(bindings: Record<string, unknown>): Record<string, string> {
  if (!bindings.MCP_AUTH_TOKEN || !bindings.INTERNAL_EXECUTION_TOKEN) {
    throw new Error("MCP_AUTH_TOKEN and INTERNAL_EXECUTION_TOKEN secrets are required");
  }
  const runtime = [
    "MCP_AUTH_TOKEN",
    "INTERNAL_EXECUTION_TOKEN",
    "WORKSPACE_ID",
    "MCP_ALLOWED_HOSTS",
    "MCP_ALLOWED_ORIGINS",
    "TARGETS_JSON",
    "OPENSENPAI_CONFIG",
    "OPENROUTER_API_KEY",
    "EXA_API_KEY",
  ];
  const configured =
    typeof bindings.PROVIDER_API_KEY_ENVS === "string"
      ? bindings.PROVIDER_API_KEY_ENVS.split(",").map((name) => name.trim())
      : [];
  const keys = [
    ...runtime,
    ...configured.filter(
      (name) =>
        /^[A-Z][A-Z0-9_]*$/.test(name) &&
        !/^(CLERK_|STRIPE_|MPP_|HOSTED_|DATABASE_|MASTRA_|CLOUDFLARE_|CF_)/.test(name),
    ),
  ];
  const values = Object.fromEntries(
    keys.flatMap((key) => (typeof bindings[key] === "string" ? [[key, bindings[key]]] : [])),
  );
  return {
    ...values,
    NODE_ENV: "production",
    STORAGE_BACKEND: "cloudflare",
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
