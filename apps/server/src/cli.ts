#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createApplication } from "./application.js";
import type { ApplicationOptions } from "./config.js";
import { publicError } from "./mcp.js";

const help = `Usage: opensenpai [options]
  --role all|api|worker       Process role (default: all)
  --transport http|stdio     MCP transport (default: http)
  --database-url URL         Durable LibSQL database URL
  --host HOST                Bind address (default: 127.0.0.1)
  --port PORT                HTTP port (default: 4111)
  --help                     Show this help

HTTP requires MCP_AUTH_TOKEN with at least 16 characters.
Workers and external queues require a distinct INTERNAL_EXECUTION_TOKEN.
`;

export async function main(
  argv = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      role: { type: "string" },
      transport: { type: "string" },
      "database-url": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const options = {
    role: values.role,
    transport: values.transport,
    databaseUrl: values["database-url"],
    port: values.port === undefined ? undefined : Number(values.port),
    host: values.host,
  } as ApplicationOptions;
  const app = await createApplication(env, options);
  let shutdown: Promise<void> | undefined;
  const close = () => {
    shutdown ??= app.close().finally(() => {
      process.removeListener("SIGINT", signal);
      process.removeListener("SIGTERM", signal);
      process.stdin.removeListener("end", stdinEnd);
    });
    return shutdown;
  };
  const signal = () => {
    const deadline = setTimeout(() => {
      process.stderr.write("Shutdown deadline exceeded. Durable leases will recover on restart.\n");
      process.exit(1);
    }, 10_000);
    deadline.unref();
    void close()
      .catch(() => {
        process.stderr.write(
          "Shutdown could not complete. Inspect durable run state before retrying.\n",
        );
        process.exitCode = 1;
      })
      .finally(() => clearTimeout(deadline));
  };
  const stdinEnd = () => signal();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  if (app.config.transport === "stdio") process.stdin.once("end", stdinEnd);
  else
    process.stderr.write(
      `OpenSenpai ${app.config.role} listening on ${app.config.host}:${app.port}\n`,
    );
  return { ...app, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
    process.exitCode = 1;
  });
}
