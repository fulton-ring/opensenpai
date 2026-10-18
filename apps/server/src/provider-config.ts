import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ResearchError } from "@opensenpai/core/contracts";
import { defaultProviders, type ProviderRegistry } from "@opensenpai/core/providers";
import { loadTargets } from "@opensenpai/core/targets";

/** Select a trusted local module or explicitly override its provider registry and presets. */
export interface ProviderConfigurationOptions {
  configPath?: string;
  targets?: unknown;
  providers?: ProviderRegistry;
}

function invalidConfig(): never {
  throw new ResearchError(
    "INVALID_CONFIG",
    "Provider configuration must be a trusted local .js/.mjs module exporting valid targets and providers.",
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function registry(value: unknown): ProviderRegistry {
  if (!object(value) || Object.keys(value).some((key) => !["models", "retrievals"].includes(key)))
    return invalidConfig();
  validateEntries(value.models, ["availability", "execute"], ["resolveTarget", "listModels"]);
  validateEntries(value.retrievals, ["availability", "estimate", "retrieve"]);
  return value as unknown as ProviderRegistry;
}

function validateEntries(value: unknown, methods: string[], optionalMethods: string[] = []) {
  if (!object(value)) return invalidConfig();
  for (const [id, entry] of Object.entries(value)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(id) ||
      !object(entry) ||
      methods.some((method) => typeof entry[method] !== "function") ||
      optionalMethods.some(
        (method) => entry[method] !== undefined && typeof entry[method] !== "function",
      )
    )
      return invalidConfig();
  }
}

async function configurationModule(path: string, explicit: boolean) {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path) || ![".js", ".mjs"].includes(extname(path)))
    return invalidConfig();
  try {
    await stat(path);
  } catch (error) {
    if (!explicit && object(error) && error.code === "ENOENT") return undefined;
    return invalidConfig();
  }
  try {
    const value: unknown = (await import(pathToFileURL(path).href)).default;
    if (!object(value) || Object.keys(value).some((key) => !["targets", "providers"].includes(key)))
      return invalidConfig();
    if (value.providers !== undefined) registry(value.providers);
    if (value.targets !== undefined) {
      if (!Array.isArray(value.targets)) return invalidConfig();
      loadTargets({}, value.targets);
    }
    return value;
  } catch {
    return invalidConfig();
  }
}

/** Load operator-owned ESM configuration, validate its shape, and resolve override precedence. */
export async function loadProviderConfiguration(
  env: Record<string, string | undefined>,
  options: ProviderConfigurationOptions = {},
  cwd = process.cwd(),
) {
  const requested = options.configPath ?? env.OPENSENPAI_CONFIG;
  if (requested !== undefined && (!requested.trim() || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(requested)))
    return invalidConfig();
  const configPath = resolve(cwd, requested ?? "opensenpai.config.mjs");
  const configured = await configurationModule(configPath, requested !== undefined);
  try {
    const targets = loadTargets(
      env,
      options.targets ?? (env.TARGETS_JSON !== undefined ? undefined : configured?.targets),
    );
    const providers = options.providers ?? configured?.providers ?? defaultProviders;
    return { targets, providers: registry(providers), ...(configured ? { configPath } : {}) };
  } catch {
    return invalidConfig();
  }
}
