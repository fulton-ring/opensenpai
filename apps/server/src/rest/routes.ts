import type { IncomingMessage, ServerResponse } from "node:http";
import { ResearchError } from "@opensenpai/core/contracts";
import type { ResearchService } from "@opensenpai/core/service";
import { cancelInput, discoveryInput, listInput, resultsInput, runId, runQuery } from "./input.js";
import { errorResponse, json, MAX_BODY, query, readJson } from "./protocol.js";

const root = "/api/v1/research";
const methods = new Map([
  [`${root}/targets`, "GET"],
  [`${root}/estimates`, "POST"],
  [`${root}/runs`, "GET, POST"],
]);
/** Dispatch authenticated research resources directly to the shared service. */
export async function researchRoutes(
  service: ResearchService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) {
  try {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
      req.resume();
      throw new ResearchError("BODY_TOO_LARGE", "Request exceeds 1 MiB.");
    }
    const run = /^\/api\/v1\/research\/runs\/([^/]+)(\/observations)?$/.exec(url.pathname);
    const allow = methods.get(url.pathname) ?? (run ? (run[2] ? "GET" : "GET, PATCH") : undefined);
    if (!allow) return json(res, 404, { error: { code: "NOT_FOUND" } });
    if (!allow.split(", ").includes(req.method ?? "")) {
      res.setHeader("allow", allow);
      return json(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: `Use ${allow}.` } });
    }
    if (run) return await runResource(service, req, res, url, run);
    return await collection(service, req, res, url);
  } catch (error) {
    errorResponse(res, error);
  }
}

async function collection(
  service: ResearchService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) {
  const fields = query(url);
  if (url.pathname === `${root}/targets`)
    return json(res, 200, await service.listTargets(discoveryInput.parse(fields)));
  if (req.method === "GET") return json(res, 200, await service.listRuns(listInput.parse(fields)));
  if (Object.keys(fields).length)
    throw new ResearchError("INVALID_INPUT", "This resource does not accept query parameters.");
  const input = await readJson(req);
  if (url.pathname === `${root}/estimates`) return json(res, 200, await service.estimateRun(input));
  const result = await service.startRun(input);
  if (result.created)
    res.setHeader("location", `${root}/runs/${encodeURIComponent(result.run.id)}`);
  return json(res, result.created ? 201 : 200, result);
}

async function runResource(
  service: ResearchService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  match: RegExpExecArray,
) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1] ?? "");
  } catch {
    throw new ResearchError("INVALID_INPUT", "Invalid encoded run ID.");
  }
  const run_id = runId.parse(decoded);
  const fields = query(url);
  if (match[2])
    return json(res, 200, await service.getResults({ run_id, ...resultsInput.parse(fields) }));
  if (req.method === "GET")
    return json(res, 200, await service.getRun({ run_id, ...runQuery.parse(fields) }));
  if (Object.keys(fields).length)
    throw new ResearchError("INVALID_INPUT", "Cancellation does not accept query parameters.");
  cancelInput.parse(await readJson(req));
  return json(res, 200, await service.cancelRun({ run_id }));
}
