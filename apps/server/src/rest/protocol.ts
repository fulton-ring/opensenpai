import type { IncomingMessage, ServerResponse } from "node:http";
import { ResearchError } from "@opensenpai/core/contracts";
import { z } from "zod";
import { publicError } from "../mcp.js";

/** Maximum accepted JSON body, measured as received bytes. */
export const MAX_BODY = 1_048_576;
/** Send uncached JSON without replacing an already completed or rejected response. */
export function json(res: ServerResponse, status: number, value: unknown) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

/** Map research failures to HTTP statuses while hiding unexpected implementation errors. */
export function errorResponse(res: ServerResponse, error: unknown) {
  const failure = publicError(error);
  const statuses: Record<string, number> = {
    RUN_NOT_FOUND: 404,
    IDEMPOTENCY_CONFLICT: 409,
    BODY_TOO_LARGE: 413,
    JSON_REQUIRED: 415,
  };
  const status =
    statuses[failure.code] ??
    (error instanceof ResearchError || error instanceof z.ZodError ? 400 : 500);
  json(res, status, { error: failure });
}

/** Reject duplicate query fields before applying a strict resource-specific schema. */
export function query(url: URL) {
  const fields: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(fields, key))
      throw new ResearchError("INVALID_INPUT", "Query parameters must not be repeated.");
    fields[key] = value;
  }
  return fields;
}

/** Parse one JSON object with a byte limit, draining rejected bodies for a reliable HTTP response. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    req.resume();
    throw new ResearchError("JSON_REQUIRED", "Use application/json.");
  }
  const text = await readBody(req);
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ResearchError("INVALID_JSON", "A JSON object is required.");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        req.removeListener("data", data);
        chunks.length = 0;
        reject(new ResearchError("BODY_TOO_LARGE", "Request exceeds 1 MiB."));
        req.resume();
      } else chunks.push(chunk);
    };
    req.on("data", data);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
    req.once("aborted", () => reject(new Error("Request aborted")));
  });
}
