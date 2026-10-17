import { ResearchError } from "@opensenpai/core/contracts";
import { z } from "zod";

export interface ApplicationOptions {
  role?: "all" | "api" | "worker";
  transport?: "http" | "stdio";
  databaseUrl?: string;
  port?: number;
  host?: string;
  targets?: unknown;
  listen?: boolean;
}
export function loadConfig(
  env: Record<string, string | undefined>,
  options: ApplicationOptions = {},
) {
  const role = z.enum(["all", "api", "worker"]).parse(options.role ?? env.ROLE ?? "all");
  const transport = z.enum(["http", "stdio"]).parse(options.transport ?? env.TRANSPORT ?? "http");
  const port = z.coerce
    .number()
    .int()
    .min(0)
    .max(65_535)
    .parse(options.port ?? env.PORT ?? 4111);
  const host = z
    .string()
    .min(1)
    .max(253)
    .parse(options.host ?? env.HOST ?? "127.0.0.1");
  const databaseUrl = z
    .string()
    .min(1)
    .parse(options.databaseUrl ?? env.DATABASE_URL ?? "file:./data/opensenpai.db");
  const workspaceId = z
    .string()
    .min(1)
    .max(160)
    .parse(env.WORKSPACE_ID ?? "local");
  const dispatchMode = z
    .enum(["native", "external"])
    .parse(env.OBSERVATION_DISPATCH_MODE ?? "native");
  const mcpToken = env.MCP_AUTH_TOKEN;
  const internalToken = env.INTERNAL_EXECUTION_TOKEN;
  validateAuth(role, transport, dispatchMode, mcpToken, internalToken);
  const mastraStorageUrl =
    env.MASTRA_STORAGE_URL ??
    (databaseUrl.startsWith("file:") ? `${databaseUrl}.mastra.db` : databaseUrl);
  const split = (value: string | undefined) =>
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    role,
    transport,
    port,
    host,
    databaseUrl,
    workspaceId,
    dispatchMode,
    mcpToken,
    internalToken,
    mastraStorageUrl,
    allowedHosts: split(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: split(env.MCP_ALLOWED_ORIGINS),
  };
}

function validateAuth(
  role: string,
  transport: string,
  dispatchMode: string,
  mcpToken?: string,
  internalToken?: string,
) {
  if (transport === "http" && role !== "worker" && (!mcpToken || mcpToken.length < 16))
    throw new ResearchError(
      "INVALID_CONFIG",
      "MCP_AUTH_TOKEN must contain at least 16 characters for HTTP transport.",
    );
  if (
    (role === "worker" || dispatchMode === "external") &&
    (!internalToken || internalToken.length < 16)
  )
    throw new ResearchError(
      "INVALID_CONFIG",
      "INTERNAL_EXECUTION_TOKEN must contain at least 16 characters for workers and external dispatch.",
    );
  if (internalToken && internalToken.length < 16)
    throw new ResearchError(
      "INVALID_CONFIG",
      "INTERNAL_EXECUTION_TOKEN must contain at least 16 characters.",
    );
  if (internalToken && internalToken === mcpToken)
    throw new ResearchError(
      "INVALID_CONFIG",
      "INTERNAL_EXECUTION_TOKEN must differ from MCP_AUTH_TOKEN.",
    );
  if (role === "worker" && transport === "stdio")
    throw new ResearchError(
      "INVALID_CONFIG",
      "Worker role uses private HTTP health; stdio requires role all or api.",
    );
}
