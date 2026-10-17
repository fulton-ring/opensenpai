import type { OutboundHandlerContext } from "@cloudflare/containers";
import {
  isResearchRequest,
  type ResearchRequest,
  type ResearchResponse,
  type ResearchStorage,
  serializeResearchError,
} from "@opensenpai/core/storage";

interface PrivateStorageEnvironment {
  DB: D1Database;
  APPLICATION: {
    idFromString(id: string): DurableObjectId;
    get(id: DurableObjectId): { researchRpc(body: unknown): Promise<ResearchResponse> };
  };
}

const invalidRequest = {
  error: {
    code: "INVALID_STORAGE_REQUEST",
    message: "Invalid private storage request",
    retryable: false,
  },
};

function hasKeys(body: unknown, keys: string[]): body is Record<string, unknown> {
  return (
    !!body &&
    typeof body === "object" &&
    Object.keys(body).length === keys.length &&
    keys.every((key) => Object.hasOwn(body, key))
  );
}

function isD1Value(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) &&
      value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
  );
}

function isD1Request(body: unknown): body is { sql: string; params: unknown[] } {
  return (
    hasKeys(body, ["sql", "params"]) &&
    typeof body.sql === "string" &&
    !!body.sql.trim() &&
    Array.isArray(body.params) &&
    body.params.every(isD1Value)
  );
}

function isRpcRequest(body: unknown): body is ResearchRequest {
  return hasKeys(body, ["method", "args"]) && isResearchRequest(body);
}

/** Only installed on the container's private outbound hostname, never public ingress. */
export async function handlePrivateStorage(
  request: Request,
  env: PrivateStorageEnvironment,
  ctx: Pick<OutboundHandlerContext, "containerId">,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== "http://cloudflare-storage" || !["/d1", "/research"].includes(url.pathname))
    return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(invalidRequest, { status: 400 });
  }
  try {
    if (url.pathname === "/d1") {
      if (!isD1Request(body)) return Response.json(invalidRequest, { status: 400 });
      const result = await env.DB.prepare(body.sql)
        .bind(...body.params)
        .all();
      if (!result.success) throw new Error("D1 storage operation failed");
      return Response.json({ result: [result] });
    }
    if (!isRpcRequest(body)) return Response.json(invalidRequest, { status: 400 });
    const owner = env.APPLICATION.get(env.APPLICATION.idFromString(ctx.containerId));
    return Response.json(await owner.researchRpc(body));
  } catch (error) {
    return Response.json({ error: serializeResearchError(error) }, { status: 500 });
  }
}

/** Cache initialization per owning Durable Object, including concurrent first calls. */
export function createResearchRpc(store: ResearchStorage) {
  let initialized: Promise<void> | undefined;
  return async (body: unknown): Promise<ResearchResponse> => {
    if (!isRpcRequest(body)) return invalidRequest;
    try {
      initialized ??= store.initialize().catch((error) => {
        initialized = undefined;
        throw error;
      });
      await initialized;
      if (body.method === "initialize") return { result: null };
      const operation = store[body.method] as (...args: unknown[]) => Promise<unknown>;
      // JSON encodes omitted positional arguments as null; optional store arguments use undefined.
      const args = body.args.map((value) => (value === null ? undefined : value));
      return { result: (await operation.apply(store, args)) ?? null };
    } catch (error) {
      return { error: serializeResearchError(error) };
    }
  };
}
