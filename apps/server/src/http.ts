import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MCPServer } from "@mastra/mcp";
import type { Observation } from "@opensenpai/core/contracts";
import type { ResearchService, ServiceStore } from "@opensenpai/core/service";
import { publicError } from "./mcp.js";
import { readJson } from "./rest/protocol.js";
import { researchRoutes } from "./rest/routes.js";

/** Dependencies and access policies for MCP, health, and internal observation HTTP routes. */
export interface HttpOptions {
  mcp?: Pick<MCPServer, "startHTTP">;
  service?: ResearchService;
  store: Pick<ServiceStore, "getRun" | "getResults"> & {
    listToolCalls(runId?: string): Promise<unknown[]>;
    listUnqueued(limit?: number): Promise<Observation[]>;
    recoverExpired(): Promise<number>;
    markQueued(id: string): Promise<void>;
    getObservation(id: string): Promise<Observation | null>;
  };
  runtime: { executeObservation(id: string): Promise<unknown>; retrySettlements?(): Promise<void> };
  role: "all" | "api" | "worker";
  mcpToken?: string;
  internalToken?: string;
  host?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

function authorized(req: IncomingMessage, token: string | undefined) {
  if (!token) return false;
  const supplied = req.headers.authorization ?? "";
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(`Bearer ${token}`).digest(),
  );
}

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
const terminal = new Set(["succeeded", "failed", "cancelled", "unknown_outcome"]);
const MAX_BODY = 1_048_576;

/** Create a bounded HTTP server with separate MCP and internal execution credentials. */
export function createHttpServer(options: HttpOptions) {
  if (options.internalToken && options.internalToken === options.mcpToken)
    throw new Error("INTERNAL_EXECUTION_TOKEN must differ from MCP_AUTH_TOKEN.");
  const hosts = options.allowedHosts ?? [
    "127.0.0.1",
    "localhost",
    "[::1]",
    ...(options.host && !["0.0.0.0", "::"].includes(options.host) ? [options.host] : []),
  ];
  const origins = options.allowedOrigins ?? [];
  let active = 0;
  const server = createServer(
    { maxHeaderSize: 16_384, requestTimeout: 150_000, headersTimeout: 15_000 },
    (req, res) => {
      active++;
      res.on("close", () => active--);
      void handle(options, hosts, origins, active, req, res).catch((error: unknown) =>
        json(res, 500, { error: publicError(error) }),
      );
    },
  );
  server.maxRequestsPerSocket = 1_000;
  server.keepAliveTimeout = 5_000;

  return server;
}

async function handle(
  options: HttpOptions,
  hosts: string[],
  origins: string[],
  active: number,
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (active > 100)
    return json(res, 503, { error: { code: "SERVER_BUSY", message: "Retry shortly." } });
  const url = requestUrl(req, res, hosts, origins);
  if (!url) return;
  const research = url.pathname.startsWith("/api/v1/research");
  if (!research && !limitBody(req, res)) return;
  if (req.method === "GET" && ["/health", "/ready"].includes(url.pathname)) {
    return health(options, req, res, url.pathname === "/ready");
  }
  const execution = url.pathname.startsWith("/internal/observations/");
  if (!authorized(req, execution ? options.internalToken : options.mcpToken))
    return json(res, 401, { error: { code: "UNAUTHORIZED" } });
  if (research && options.service && options.role !== "worker")
    return researchRoutes(options.service, req, res, url);
  if (url.pathname === "/mcp" && options.mcp && options.role !== "worker")
    return nativeMcp(options.mcp, hosts, req, res, url);
  return routes(options, req, res, url);
}

async function nativeMcp(
  mcp: NonNullable<HttpOptions["mcp"]>,
  hosts: string[],
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) {
  if (
    req.method === "POST" &&
    !req.headers["content-type"]?.toLowerCase().startsWith("application/json")
  )
    return json(res, 415, { error: { code: "JSON_REQUIRED" } });
  await mcp.startHTTP({
    url,
    httpPath: "/mcp",
    req,
    res,
    options: { enableDnsRebindingProtection: true, allowedHosts: hosts },
  });
}

function limitBody(req: IncomingMessage, res: ServerResponse) {
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
    json(res, 413, { error: { code: "BODY_TOO_LARGE" } });
    return false;
  }
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BODY) {
      json(res, 413, { error: { code: "BODY_TOO_LARGE" } });
      req.destroy();
    }
  });

  return true;
}

async function routes(options: HttpOptions, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (
    req.method === "POST" &&
    url.pathname === "/internal/observations/reservation" &&
    options.service
  )
    return json(res, 200, await options.service.estimateRun(await readJson(req)));
  if (req.method === "GET" && url.pathname === "/internal/audit")
    return json(res, 200, {
      toolCalls: await options.store.listToolCalls(url.searchParams.get("run_id") ?? undefined),
    });
  if (req.method === "GET" && url.pathname === "/internal/observations/outbox") {
    await options.store.recoverExpired();
    return json(res, 200, {
      observations: (await options.store.listUnqueued(100)).map(({ id }) => ({ id })),
    });
  }
  if (req.method === "POST" && url.pathname === "/internal/observations/reconcile") {
    await options.runtime.retrySettlements?.();
    return json(res, 200, { reconciled: true });
  }
  const run = /^\/internal\/runs\/([^/]+)(\/results)?$/.exec(url.pathname);
  if (req.method === "GET" && run) return runRoute(options, res, url, run);
  const observation = /^\/internal\/observations\/([^/]+)\/(queued|execute)$/.exec(url.pathname);
  if (req.method === "POST" && observation) return observationRoute(options, res, observation);
  return json(res, 404, { error: { code: "NOT_FOUND" } });
}

async function runRoute(options: HttpOptions, res: ServerResponse, url: URL, run: RegExpExecArray) {
  const id = decodeURIComponent(run[1] ?? "");
  if (!(await options.store.getRun(id)))
    return json(res, 404, { error: { code: "RUN_NOT_FOUND" } });
  if (!run[2]) return json(res, 200, await options.store.getRun(id));
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== null && (!Number.isInteger(Number(cursor)) || Number(cursor) < 0))
  )
    return json(res, 400, { error: { code: "INVALID_PAGINATION" } });
  return json(
    res,
    200,
    await options.store.getResults({
      run_id: id,
      limit,
      cursor: cursor === null ? undefined : Number(cursor),
      include_raw: url.searchParams.get("include_raw") === "true",
    }),
  );
}

async function observationRoute(
  options: HttpOptions,
  res: ServerResponse,
  observation: RegExpExecArray,
) {
  const id = decodeURIComponent(observation[1] ?? "");
  if (!(await options.store.getObservation(id)))
    return json(res, 503, {
      error: {
        code: "OBSERVATION_NOT_READY",
        message: "Observation is not durably available. Retry.",
      },
    });
  if (observation[2] === "queued") {
    await options.store.markQueued(id);
    return json(res, 200, { queued: true });
  }
  try {
    await options.runtime.executeObservation(id);
  } catch {
    /* Durable state below determines whether queue acknowledgement is safe. */
  }
  const durable = await options.store.getObservation(id);
  if (!durable) return json(res, 503, { error: { code: "OBSERVATION_NOT_READY" } });
  if (!terminal.has(durable.status))
    return json(res, 409, {
      error: {
        code: "OBSERVATION_NOT_TERMINAL",
        message: "Observation remains pending or leased. Retry.",
      },
    });
  return json(res, 200, { id: durable.id, status: durable.status });
}

function requestUrl(req: IncomingMessage, res: ServerResponse, hosts: string[], origins: string[]) {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    json(res, 400, { error: { code: "INVALID_URL" } });
    return null;
  }
  if (!hosts.includes(url.hostname)) {
    json(res, 403, { error: { code: "HOST_FORBIDDEN" } });
    return null;
  }
  const origin = req.headers.origin;
  if (origin && !origins.includes(origin) && origin !== url.origin) {
    json(res, 403, { error: { code: "ORIGIN_FORBIDDEN" } });
    return null;
  }
  return url;
}

async function health(
  options: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
  readiness: boolean,
) {
  if (options.role === "worker" && !authorized(req, options.internalToken))
    return json(res, 401, { error: { code: "UNAUTHORIZED" } });
  if (readiness) {
    try {
      await options.store.listUnqueued(1);
    } catch {
      return json(res, 503, {
        error: { code: "NOT_READY", message: "Durable storage is unavailable. Retry shortly." },
      });
    }
  }
  return json(res, 200, { status: readiness ? "ready" : "ok", role: options.role });
}
