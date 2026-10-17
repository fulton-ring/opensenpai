import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("server configuration", () => {
  it("requires strong HTTP auth and separates internal execution credentials", () => {
    expect(() => loadConfig({})).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => loadConfig({ MCP_AUTH_TOKEN: "short" })).toThrow(/MCP_AUTH_TOKEN/);
    expect(() =>
      loadConfig({
        MCP_AUTH_TOKEN: "long-token-123456",
        INTERNAL_EXECUTION_TOKEN: "long-token-123456",
      }),
    ).toThrow(/differ/);
  });
  it("allows process-owned stdio without a bearer token", () => {
    expect(loadConfig({}, { transport: "stdio" })).toMatchObject({
      transport: "stdio",
      role: "all",
      host: "127.0.0.1",
      port: 4111,
    });
  });
  it("requires internal auth for private worker health and external queue execution", () => {
    expect(() => loadConfig({}, { role: "worker" })).toThrow(/INTERNAL_EXECUTION_TOKEN/);
    expect(() =>
      loadConfig({ MCP_AUTH_TOKEN: "long-token-123456", OBSERVATION_DISPATCH_MODE: "external" }),
    ).toThrow(/INTERNAL_EXECUTION_TOKEN/);
  });
  it("rejects invalid role/transport/port before opening resources", () => {
    expect(() => loadConfig({ MCP_AUTH_TOKEN: "long-token-123456", PORT: "nope" })).toThrow();
    expect(() => loadConfig({ MCP_AUTH_TOKEN: "long-token-123456", ROLE: "invalid" })).toThrow();
  });
});
