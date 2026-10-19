import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProviderConfiguration } from "../../src/provider-config.js";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "opensenpai-config-"));
  directories.push(path);
  return path;
}

async function moduleFile(path: string, source: string, name = "opensenpai.config.mjs") {
  await writeFile(join(path, name), source);
  return join(path, name);
}
const target = {
  id: "custom-target",
  transport: "custom",
  model: "custom-model",
  search: { mode: "off" },
};
const moduleSource = `export default {
  targets: ${JSON.stringify([target])},
  providers: { models: { custom: {
    availability() { return { available: true }; },
    async execute() { throw new Error("not dispatched"); }
  } }, retrievals: {} }
};`;
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("trusted local provider configuration", () => {
  it("loads the conventional module and validates custom provider functions", async () => {
    const path = await directory();
    await moduleFile(path, moduleSource);
    const config = await loadProviderConfiguration({}, {}, path);
    expect(config.targets).toMatchObject([target]);
    const first = config.targets[0];
    if (!first) throw new Error("Missing configured target");
    expect(config.providers.models.custom?.availability(first, { env: {}, fetch })).toEqual({
      available: true,
    });
    expect(config.configPath).toBe(join(path, "opensenpai.config.mjs"));
  });
  it("uses built-ins only when the implicit conventional module is absent", async () => {
    const path = await directory();
    const config = await loadProviderConfiguration({}, {}, path);
    expect(config.targets).toEqual([]);
    expect(config.providers.models.openrouter).toBeDefined();
    expect(config.configPath).toBeUndefined();
    await expect(
      loadProviderConfiguration({ OPENSENPAI_CONFIG: "missing.mjs" }, {}, path),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
  it("honors CLI/module selection and targets/options precedence independently", async () => {
    const path = await directory();
    await moduleFile(path, "throw new Error('ignored module')", "env.mjs");
    await moduleFile(path, moduleSource, "cli.mjs");
    const override = { ...target, id: "environment-target" };
    const options = { configPath: "cli.mjs" };
    const env = { OPENSENPAI_CONFIG: "env.mjs", TARGETS_JSON: JSON.stringify([override]) };
    expect((await loadProviderConfiguration(env, options, path)).targets[0]?.id).toBe(override.id);
    const providers = { models: {}, retrievals: {} };
    const config = await loadProviderConfiguration(
      env,
      { ...options, targets: [target], providers },
      path,
    );
    expect(config.targets[0]?.id).toBe(target.id);
    expect(config.providers).toBe(providers);
  });
  it("accepts empty presets because models can be selected through MCP", async () => {
    const path = await directory();
    await moduleFile(path, "export default { targets: [] }");
    expect((await loadProviderConfiguration({}, {}, path)).targets).toEqual([]);
  });
  it.each(["resolveTarget", "listModels", "reconcileUsage"])(
    "rejects a non-function optional model hook: %s",
    async (method) => {
      const path = await directory();
      await moduleFile(
        path,
        `export default { providers: { models: { custom: { availability() {}, execute() {}, ${method}: true } }, retrievals: {} } }`,
      );
      await expect(loadProviderConfiguration({}, {}, path)).rejects.toMatchObject({
        code: "INVALID_CONFIG",
      });
    },
  );
  it.each([
    "export default { unknown: true }",
    "export default () => ({})",
    "export default { providers: { models: { custom: {} }, retrievals: {} } }",
    "export default { providers: { models: {}, retrievals: { custom: { retrieve() {} } } } }",
    "export default { targets: null }",
    "export default { providers: { models: { 'invalid id': {} }, retrievals: {} } }",
    "throw new Error('SECRET_FROM_MODULE')",
  ])("rejects malformed configuration without exposing module errors: %s", async (source) => {
    const path = await directory();
    await moduleFile(path, source);
    await expect(loadProviderConfiguration({}, {}, path)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    await expect(loadProviderConfiguration({}, {}, path)).rejects.not.toThrow(/SECRET_FROM_MODULE/);
  });
  it.each(["0bad", "bad.name", "a".repeat(81)])(
    "rejects adapter IDs that MCP cannot select: %s",
    async (id) => {
      const path = await directory();
      const source = `export default { providers: { models: { ${JSON.stringify(id)}: { availability() {}, execute() {} } }, retrievals: {} } }`;
      await moduleFile(path, source);
      await expect(loadProviderConfiguration({}, {}, path)).rejects.toMatchObject({
        code: "INVALID_CONFIG",
      });
    },
  );
  it("rejects invalid module targets even when environment targets override them", async () => {
    const path = await directory();
    await moduleFile(path, "export default { targets: [{ id: 42 }] }");
    await expect(
      loadProviderConfiguration({ TARGETS_JSON: JSON.stringify([target]) }, {}, path),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
  it.each([
    "https://example.com/provider.mjs",
    "data:text/javascript,export default {}",
    "file:///tmp/provider.mjs",
    "provider.ts",
  ])("rejects non-local or unsupported module references: %s", async (configPath) => {
    await expect(
      loadProviderConfiguration({}, { configPath }, await directory()),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});
