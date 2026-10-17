import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { ResearchError } from "@opensenpai/core/contracts";
import { createRuntime, type RuntimeOptions } from "@opensenpai/core/runtime";
import { ResearchService } from "@opensenpai/core/service";
import { type ResearchStorage, ResearchStore } from "@opensenpai/core/storage";
import { loadTargets } from "@opensenpai/core/targets";
import {
  type BridgeFetch,
  createCloudflareD1Storage,
  createCloudflareResearchStorage,
} from "./cloudflare-storage.js";
import { type ApplicationOptions, loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createResearchMcp } from "./mcp.js";

export type CreateApplicationOptions = ApplicationOptions &
  Pick<RuntimeOptions, "hooks" | "executeProvider" | "retrieveExa" | "pubsub" | "storage"> & {
    bridgeFetch?: BridgeFetch;
  };
async function ensureParent(url: string) {
  if (!url.startsWith("file:") || url.includes(":memory:")) return;
  const path = url.startsWith("file://") ? fileURLToPath(url) : url.slice(5);
  await mkdir(dirname(resolve(path)), { recursive: true });
}

export async function createApplication(
  env: Record<string, string | undefined>,
  options: CreateApplicationOptions = {},
) {
  const config = loadConfig(env, options);
  validateSharedInfrastructure(config, env.VALKEY_URL, Boolean(options.pubsub));
  const targets = loadTargets(env, options.targets);
  const { store, nativeStorage } = await createStorage(config, env, options);
  const runtime = createRuntime({
    store,
    env,
    role: config.role,
    dispatchMode: config.dispatchMode,
    directOnly: config.dispatchMode === "external",
    storage: nativeStorage,
    valkeyUrl: env.VALKEY_URL,
    timeoutMs: config.dispatchMode === "external" ? 115_000 : 120_000,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.executeProvider ? { executeProvider: options.executeProvider } : {}),
    ...(options.retrieveExa ? { retrieveExa: options.retrieveExa } : {}),
    ...(options.pubsub ? { pubsub: options.pubsub } : {}),
    onError: () =>
      process.stderr.write("Research runtime operation failed; inspect durable run status.\n"),
  });
  const service = new ResearchService({
    store,
    runtime,
    targets,
    env,
    dispatchMode: config.dispatchMode,
  });
  const mcp = createResearchMcp(service);
  runtime.mastra.addMCPServer(mcp, "aeo");
  let server: Server | undefined;
  const close = createCloser(runtime, mcp, nativeStorage, store, () => server);
  try {
    await store.initialize();
    await runtime.start();
    server = await startTransport(config, store, runtime, mcp, options.listen);
    return {
      store,
      runtime,
      service,
      mcp,
      server,
      port: (server?.address() as AddressInfo | null)?.port ?? config.port,
      config,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function createStorage(
  config: ReturnType<typeof loadConfig>,
  env: Record<string, string | undefined>,
  options: CreateApplicationOptions,
) {
  if (config.storageBackend === "cloudflare")
    return {
      store: createCloudflareResearchStorage(config.workspaceId, options.bridgeFetch),
      nativeStorage:
        options.storage ??
        (await createCloudflareD1Storage(config.workspaceId, options.bridgeFetch)),
    };
  await ensureParent(config.databaseUrl);
  await ensureParent(config.mastraStorageUrl);
  const client = createClient({
    url: config.databaseUrl,
    ...(env.DATABASE_AUTH_TOKEN ? { authToken: env.DATABASE_AUTH_TOKEN } : {}),
  });
  return {
    store: new ResearchStore(client, config.workspaceId),
    nativeStorage:
      options.storage ??
      new LibSQLStore({
        id: `opensenpai-${config.workspaceId}`,
        url: config.mastraStorageUrl,
        ...((env.MASTRA_STORAGE_AUTH_TOKEN ?? env.DATABASE_AUTH_TOKEN)
          ? { authToken: env.MASTRA_STORAGE_AUTH_TOKEN ?? env.DATABASE_AUTH_TOKEN }
          : {}),
      }),
  };
}

function createCloser(
  runtime: { stop(): Promise<void> },
  mcp: { close(): Promise<void> },
  nativeStorage: { close(): Promise<void> },
  store: { close(): Promise<void> },
  getServer: () => Server | undefined,
) {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      const server = getServer();
      const serverClosed = server
        ? new Promise<void>((resolveClose) => {
            server?.close(() => resolveClose());
            server?.closeIdleConnections();
          })
        : Promise.resolve();
      try {
        await runtime.stop();
      } finally {
        try {
          await mcp.close();
        } finally {
          server?.closeAllConnections();
          await serverClosed;
          try {
            await nativeStorage.close();
          } finally {
            await store.close();
          }
        }
      }
    })();
    return closing;
  };
}

async function startTransport(
  config: ReturnType<typeof loadConfig>,
  store: ResearchStorage,
  runtime: ReturnType<typeof createRuntime>,
  mcp: ReturnType<typeof createResearchMcp>,
  listen?: boolean,
) {
  if (listen !== false) {
    if (config.transport === "stdio") await mcp.startStdio();
    else {
      const server = createHttpServer({
        store,
        runtime,
        mcp,
        role: config.role,
        mcpToken: config.mcpToken,
        internalToken: config.internalToken,
        host: config.host,
        allowedHosts: config.allowedHosts,
        allowedOrigins: config.allowedOrigins,
      });
      await new Promise<void>((resolveListen, reject) => {
        server?.once("error", reject);
        server?.listen(config.port, config.host, resolveListen);
      });
      return server;
    }
  }
  return undefined;
}

function validateSharedInfrastructure(
  config: ReturnType<typeof loadConfig>,
  valkeyUrl: string | undefined,
  sharedPubsub: boolean,
) {
  if (config.role !== "all" && config.dispatchMode === "native" && !sharedPubsub) {
    if (!valkeyUrl)
      throw new ResearchError(
        "INVALID_CONFIG",
        "Native split api/worker roles require VALKEY_URL. Use role all locally or external dispatch for queue consumers.",
      );
    if (!/^(libsql|https?|wss?):/.test(config.databaseUrl))
      throw new ResearchError(
        "INVALID_CONFIG",
        "Native split api/worker roles require a shared remote DATABASE_URL.",
      );
  }
}
