import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApplication } from "../../src/application.js";

const token = "research-rest-token-long-enough";
const input = {
  prompts: [{ id: "p", text: "Question?" }],
  targets: ["local"],
  idempotency_key: "rest-run",
};
let app: Awaited<ReturnType<typeof createApplication>>;
let directory: string;
let base: string;
const authorizeRun = vi.fn(async () => {});
const availability = vi.fn(() => ({ available: true }));
const execute = vi.fn(async () => {
  throw new Error("Execution must remain external");
});

async function api(path: string, method = "GET", body?: unknown) {
  return fetch(`${base}/api/v1/research${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "opensenpai-rest-"));
  app = await createApplication(
    {
      MCP_AUTH_TOKEN: token,
      INTERNAL_EXECUTION_TOKEN: "research-internal-token-long-enough",
      OBSERVATION_DISPATCH_MODE: "external",
    },
    {
      databaseUrl: `file:${join(directory, "research.db")}`,
      port: 0,
      providers: { models: { local: { availability, execute } }, retrievals: {} },
      targets: [{ id: "local", transport: "local", model: "local", search: { mode: "off" } }],
      authorizeRun,
    },
  );
  base = `http://127.0.0.1:${app.port}`;
});
afterAll(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("native HTTP research resources", () => {
  it("shares the server-only MCP bearer guard", async () => {
    expect((await fetch(`${base}/api/v1/research/targets`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/v1/research/targets`, {
          headers: { authorization: "Bearer research-internal-token-long-enough" },
        })
      ).status,
    ).toBe(401);
    const response = await api("/targets");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model_providers: ["local"],
      targets: [{ id: "local" }],
    });
  });

  it("persists idempotent runs without exposing forecast costs or executing providers", async () => {
    const estimate = await api("/estimates", "POST", input);
    expect(estimate.status).toBe(404);
    const created = await api("/runs", "POST", input);
    expect(created.status).toBe(201);
    const result = (await created.json()) as { run: { id: string }; created: boolean };
    expect(result.created).toBe(true);
    expect(result.run).not.toHaveProperty("estimated_cost_usd");
    expect(created.headers.get("location")).toBe(`/api/v1/research/runs/${result.run.id}`);
    const replay = await api("/runs", "POST", input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ run: { id: result.run.id }, created: false });
    expect((await api("/runs", "POST", { ...input, project: "different" })).status).toBe(409);
    expect(authorizeRun).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("lists, reads, paginates observations and cancels durable runs", async () => {
    const created = await api("/runs", "POST", {
      ...input,
      idempotency_key: "rest-cancel",
      project: "filter",
    });
    const { run } = (await created.json()) as { run: { id: string } };
    expect(await (await api("/runs?project=filter&limit=1")).json()).toMatchObject({
      runs: [{ id: run.id }],
      next_cursor: null,
    });
    expect(await (await api(`/runs/${run.id}?wait_ms=0`)).json()).toMatchObject({
      id: run.id,
      status: "queued",
    });
    const observations = await api(`/runs/${run.id}/observations?limit=1&include_raw=false`);
    expect(await observations.json()).toMatchObject({
      observations: [{ run_id: run.id, result: null }],
    });
    expect(await (await api(`/runs/${run.id}/observations?cursor=0`)).json()).toMatchObject({
      observations: [],
      next_cursor: null,
    });
    const cancelled = await api(`/runs/${run.id}`, "PATCH", { cancel_requested: true });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      id: run.id,
      cancel_requested: true,
      status: "cancelled",
    });
  });

  it.each(["/runs/missing", "/runs/missing/observations"])(
    "returns 404 for missing resource %s",
    async (path) => {
      const response = await api(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "RUN_NOT_FOUND" } });
    },
  );

  it("allows only cancellation on PATCH", async () => {
    expect((await api("/runs/missing", "PATCH", { cancel_requested: false })).status).toBe(400);
    expect(
      (await api("/runs/missing", "PATCH", { cancel_requested: true, role: "owner" })).status,
    ).toBe(400);
    expect((await api("/runs/missing", "PATCH", { cancel_requested: true })).status).toBe(404);
  });

  it.each([
    ["/targets", "POST", "GET"],
    ["/runs", "DELETE", "GET, POST"],
    ["/runs/missing", "POST", "GET, PATCH"],
    ["/runs/missing/observations", "PATCH", "GET"],
  ])("rejects unsupported methods for %s", async (path, method, allow) => {
    const response = await api(path, method);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow);
  });

  it.each([
    "/targets?limit=0",
    "/targets?unknown=value",
    "/targets?limit=2&limit=3",
    "/runs?limit=1.5",
    "/runs?cursor=",
    "/runs/missing?wait_ms=10001",
    "/runs/missing/observations?include_raw=garbage",
    "/runs/missing/observations?cursor=-1",
    "/runs/missing/observations?status=arbitrary",
    "/runs/%ZZ",
  ])("strictly validates request %s", async (path) => {
    expect((await api(path)).status).toBe(400);
  });

  it("rejects malformed JSON, unknown inputs and non-JSON media", async () => {
    expect((await api("/runs", "POST", { ...input, private_policy: "untrusted" })).status).toBe(
      400,
    );
    const malformed = await fetch(`${base}/api/v1/research/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "secret-unparseable-value",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("secret-unparseable-value");
    expect(
      (
        await fetch(`${base}/api/v1/research/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/jsonp" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
  });

  it("bounds both fixed-length and chunked request bodies", async () => {
    const response = await fetch(`${base}/api/v1/research/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: " ".repeat(1_048_577),
    });
    expect(response.status).toBe(413);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${base}/api/v1/research/runs`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.write(" ".repeat(700_000));
      req.end(" ".repeat(700_000));
    });
    expect(status).toBe(413);
  });

  it("sanitizes unexpected service failures", async () => {
    availability.mockImplementationOnce(() => {
      throw new Error("SECRET_PROVIDER_CREDENTIAL");
    });
    const response = await api("/targets");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("SECRET_PROVIDER_CREDENTIAL");
  });
});

it("keeps reservation calculation behind the internal execution credential", async () => {
  const endpoint = `${base}/internal/observations/reservation`;
  const invoke = (authorization: string) =>
    fetch(endpoint, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  expect((await invoke(`Bearer ${token}`)).status).toBe(401);
  const response = await invoke("Bearer research-internal-token-long-enough");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ total_observations: 1 });
  expect(execute).not.toHaveBeenCalled();
});
