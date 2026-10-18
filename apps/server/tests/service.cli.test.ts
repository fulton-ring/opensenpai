import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

describe("CLI entry point", () => {
  it("prints help without auth, storage or provider calls", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["--help"], {})).toBeUndefined();
      expect(write).toHaveBeenCalledWith(expect.stringContaining("--config"));
    } finally {
      write.mockRestore();
    }
  });
  it("selects an explicit trusted configuration path before opening storage", async () => {
    await expect(
      main(
        [
          "--config",
          "/missing-opensenpai-config.mjs",
          "--transport",
          "stdio",
          "--database-url",
          "file:/never-created/cli-config.db",
        ],
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
  it("rejects unknown flags and invalid port before starting a server", async () => {
    await expect(main(["--unknown"], {})).rejects.toThrow();
    await expect(
      main(["--port", "invalid"], { MCP_AUTH_TOKEN: "test-token-long-enough" }),
    ).rejects.toThrow();
  });
});
