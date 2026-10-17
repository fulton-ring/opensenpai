import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  applicationEnvironment,
  consumeObservations,
  dispatchOutbox,
  handleRequest,
} from "../deploy/cloudflare/handlers.js";

const token = "internal-test-token";
function environment(fetcher: (request: Request) => Promise<Response>) {
  return {
    INTERNAL_EXECUTION_TOKEN: token,
    MCP_AUTH_TOKEN: "mcp-test-token",
    APPLICATION: { fetch: fetcher },
    OBSERVATIONS: { send: async (_body: { observationId: string }) => {} },
  };
}
function message(body: unknown = { observationId: "obs-1" }) {
  const events: string[] = [];
  return { body, events, ack: () => events.push("ack"), retry: () => events.push("retry") };
}

describe("Cloudflare deployment delivery", () => {
  it("forwards string secrets at startup and requires durable remote libSQL", () => {
    expect(() => applicationEnvironment({ DATABASE_URL: "file:/app/data/test.db" })).toThrow(
      "remote libSQL",
    );
    expect(() => applicationEnvironment({ DATABASE_URL: "libsql://database.example" })).toThrow(
      "secrets",
    );
    expect(
      applicationEnvironment({
        DATABASE_URL: "libsql://database.example",
        MCP_AUTH_TOKEN: "mcp-secret",
        INTERNAL_EXECUTION_TOKEN: "internal-secret",
        CUSTOM_TARGET_KEY: "provider-secret",
        APPLICATION: { secret: "must not stringify service binding" },
        OBSERVATION_DISPATCH_MODE: "all",
      }),
    ).toEqual({
      DATABASE_URL: "libsql://database.example",
      MCP_AUTH_TOKEN: "mcp-secret",
      INTERNAL_EXECUTION_TOKEN: "internal-secret",
      CUSTOM_TARGET_KEY: "provider-secret",
      NODE_ENV: "production",
      OBSERVATION_DISPATCH_MODE: "external",
    });
  });

  it("waits for persisted completion before acknowledgement", async () => {
    let finish: (response: Response) => void = () => {};
    const env = environment(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const delivery = message();
    const consuming = consumeObservations({ messages: [delivery] }, env);
    await Promise.resolve();
    expect(delivery.events).toEqual([]);
    finish(Response.json({ status: "succeeded" }));
    await consuming;
    expect(delivery.events).toEqual(["ack"]);
  });

  it.each([409, 500, 503])(
    "retries incomplete/failed transport status %i for platform DLQ",
    async (status) => {
      const delivery = message();
      await consumeObservations(
        { messages: [delivery] },
        environment(async () => new Response(null, { status })),
      );
      expect(delivery.events).toEqual(["retry"]);
    },
  );

  it("retries malformed messages without invoking execution", async () => {
    let executed = false;
    const env = environment(async () => {
      executed = true;
      return new Response();
    });
    const delivery = message({ observationId: "x", prompt: "must not travel in queue" });
    await consumeObservations({ messages: [delivery] }, env);
    expect(executed).toBe(false);
    expect(delivery.events).toEqual(["retry"]);
  });

  it("retries when the container becomes unavailable", async () => {
    const delivery = message();
    await consumeObservations(
      { messages: [delivery] },
      environment(async () => {
        throw new Error("cold start");
      }),
    );
    expect(delivery.events).toEqual(["retry"]);
  });

  it("sends only the observation id and marks queued only after acceptance", async () => {
    const events: string[] = [];
    const env = environment(async (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      if (request.method === "GET") return Response.json({ observations: [{ id: "obs-1" }] });
      events.push(new URL(request.url).pathname);
      return new Response(null, { status: 204 });
    });
    env.OBSERVATIONS.send = async (body) => {
      events.push(JSON.stringify(body));
    };
    await dispatchOutbox(env);
    expect(events).toEqual(['{"observationId":"obs-1"}', "/internal/observations/obs-1/queued"]);
  });

  it("leaves the durable outbox untouched when queue acceptance fails", async () => {
    const paths: string[] = [];
    const env = environment(async (request) => {
      paths.push(new URL(request.url).pathname);
      return Response.json({ observations: [{ id: "obs-1" }] });
    });
    env.OBSERVATIONS.send = async () => {
      throw new Error("queue unavailable");
    };
    await expect(dispatchOutbox(env)).rejects.toThrow("queue unavailable");
    expect(paths).toEqual(["/internal/observations/outbox"]);
  });

  it("does not expose internal execution or forward unauthenticated MCP traffic", async () => {
    let forwarded = false;
    const env = environment(async () => {
      forwarded = true;
      return new Response();
    });
    expect(
      (await handleRequest(new Request("https://example.com/internal/observations/x/execute"), env))
        .status,
    ).toBe(404);
    expect((await handleRequest(new Request("https://example.com/mcp"), env)).status).toBe(401);
    expect(forwarded).toBe(false);
  });

  it("proxies authenticated native MCP then repairs its accepted outbox", async () => {
    const paths: string[] = [];
    const env = environment(async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return path === "/mcp"
        ? Response.json({ native: true })
        : Response.json({ observations: [] });
    });
    const response = await handleRequest(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: { authorization: "Bearer mcp-test-token" },
      }),
      env,
    );
    expect(await response.json()).toEqual({ native: true });
    expect(paths).toEqual(["/mcp", "/internal/observations/outbox"]);
  });

  it("configures single bounded consumption and a dead letter queue", async () => {
    const config = JSON.parse(
      await readFile(new URL("../deploy/cloudflare/wrangler.json", import.meta.url), "utf8"),
    );
    expect(config.queues.consumers[0]).toMatchObject({
      max_batch_size: 1,
      max_concurrency: 1,
      max_retries: 3,
      dead_letter_queue: "opensenpai-observations-dlq",
    });
    expect(config.triggers.crons).toEqual(["* * * * *"]);
    expect(config.containers[0].max_instances).toBe(1);
  });
});
