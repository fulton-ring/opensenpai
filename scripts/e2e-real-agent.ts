import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@libsql/client";
import {
  type AuditCall,
  accountSpend,
  assertAcceptance,
  type Evidence,
  parseTranscript,
  REQUIRED_TOOLS,
  redact,
  reserveSpend,
  runChild,
  type SpendLedger,
} from "./harness.js";

type Options = {
  url: string;
  transport: "http" | "stdio";
  targets: string[];
  outputDir: string;
  full: boolean;
  model: string;
  serverEntry: string;
  storeModule: string;
  agentBin: string;
  workspace: string;
};
type Run = {
  id: string;
  status: string;
  estimated_cost_usd: number | null;
  reported_cost_usd: number;
  input: { project?: string; prompts: unknown[]; targets: string[] };
};
type Results = { observations: unknown[]; next_cursor: number | null };
type Store = {
  initialize(): Promise<void>;
  listToolCalls(runId?: string): Promise<AuditCall[]>;
  getRun(id: string): Promise<Run>;
  getResults(query: { run_id: string; limit: number; cursor?: number }): Promise<Results>;
  close(): Promise<void>;
};
type Reader = {
  audit(): Promise<AuditCall[]>;
  run(id: string): Promise<Run>;
  results(id: string): Promise<unknown[]>;
  close(): Promise<void>;
};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function checkTargets(targets: string[]): void {
  if (
    !targets.length ||
    targets.length > 2 ||
    new Set(targets).size !== targets.length ||
    targets.some((target) => !/^[\w-]{1,80}$/.test(target))
  ) {
    throw new Error(
      "Choose one or two explicit targets with --target or E2E_TARGETS (router-exa/openai-exa)",
    );
  }
}

export function harnessOptions(args: string[], env: NodeJS.ProcessEnv): Options {
  if (env.OPENSENPAI_LIVE_TESTS !== "1")
    throw new Error("Set OPENSENPAI_LIVE_TESTS=1 to authorize paid calls");
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      transport: { type: "string" },
      target: { type: "string", multiple: true },
      "output-dir": { type: "string" },
      full: { type: "boolean" },
      model: { type: "string" },
      "server-entry": { type: "string" },
      "store-module": { type: "string" },
      "agent-bin": { type: "string" },
      workspace: { type: "string" },
    },
  });
  const targets = values.target ?? env.E2E_TARGETS?.split(",").filter(Boolean) ?? [];
  checkTargets(targets);
  const transport = values.transport ?? env.E2E_TRANSPORT ?? "http";
  if (transport !== "http" && transport !== "stdio")
    throw new Error("Transport must be http or stdio");
  const url = values.url ?? env.E2E_URL ?? "http://127.0.0.1:4111";
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Invalid server URL");
  return {
    url: url.replace(/\/$/, ""),
    transport,
    targets,
    outputDir: resolve(
      values["output-dir"] ?? env.E2E_OUTPUT_DIR ?? join(ROOT, ".artifacts/real-agent"),
    ),
    full: values.full ?? env.E2E_FULL === "1",
    model: values.model ?? env.E2E_AGENT_MODEL ?? "claude-haiku-5-5",
    serverEntry: resolve(
      values["server-entry"] ?? env.E2E_SERVER_ENTRY ?? join(ROOT, "dist/cli.js"),
    ),
    storeModule: resolve(
      values["store-module"] ?? env.E2E_STORE_MODULE ?? join(ROOT, "dist/store.js"),
    ),
    agentBin: values["agent-bin"] ?? env.E2E_AGENT_BIN ?? "claude",
    workspace: values.workspace ?? env.E2E_WORKSPACE_ID ?? "local",
  };
}

export function agentEnvironment(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const allowed = ["PATH", "LANG", "LC_ALL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
  return {
    ...Object.fromEntries(allowed.filter((key) => env[key]).map((key) => [key, env[key]])),
    HOME: cwd,
    TMPDIR: cwd,
    XDG_CONFIG_HOME: cwd,
    CLAUDE_CONFIG_DIR: join(cwd, ".claude"),
  };
}

export function makeMcpConfig(options: Options, env: NodeJS.ProcessEnv, database: string): unknown {
  if (options.transport === "http") {
    if (!env.MCP_AUTH_TOKEN) throw new Error("MCP_AUTH_TOKEN is required for HTTP acceptance");
    return {
      mcpServers: {
        aeo: {
          type: "http",
          url: `${options.url}/mcp`,
          headers: { Authorization: `Bearer ${env.MCP_AUTH_TOKEN}` },
        },
      },
    };
  }
  const keys = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "EXA_API_KEY",
    "PERPLEXITY_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "TARGETS_JSON",
    "OPENSENPAI_TARGETS_JSON",
  ];
  const serverEnv = Object.fromEntries(
    keys.filter((key) => env[key]).map((key) => [key, env[key]]),
  );
  return {
    mcpServers: {
      aeo: {
        command: process.execPath,
        args: [
          options.serverEntry,
          "--transport",
          "stdio",
          "--role",
          "all",
          "--database-url",
          `file:${database}`,
        ],
        env: { ...serverEnv, WORKSPACE_ID: options.workspace },
      },
    },
  };
}

export const BUSINESS_PROMPTS = [
  {
    id: "ai-readiness",
    text: "Assess how Fulton Ring at https://fultonring.com helps a midmarket company evaluate AI readiness and prioritize practical opportunities. Cite the company's public evidence.",
  },
  {
    id: "internal-ai",
    text: "Describe Fulton Ring's approach to internal AI applications using company records with source citations and permissions-aware retrieval. Ground the answer in https://fultonring.com and identify evidence gaps.",
  },
  {
    id: "manufacturing",
    text: "Evaluate Fulton Ring's fit for manufacturing reporting across ERP data, spreadsheets, and meter readings. Use public evidence from https://fultonring.com, distinguishing documented capabilities from assumptions.",
  },
  {
    id: "financial-extraction",
    text: "Explain whether Fulton Ring could support K-1 and brokerage statement extraction with human review. Cite https://fultonring.com and clearly label anything not evidenced publicly.",
  },
  {
    id: "legacy-gis",
    text: "Evaluate Fulton Ring's relevant experience for migrating legacy databases and GIS records into open formats. Cite evidence from https://fultonring.com and state limitations.",
  },
];

function agentPrompt(options: Options, suite: string): string {
  const prompts = options.full ? BUSINESS_PROMPTS : BUSINESS_PROMPTS.slice(0, 1);
  return `You are operating the aeo MCP research service for an acceptance test. Use only its seven provided tools; do not perform research yourself. List targets and ensure ${JSON.stringify(options.targets)} exist. Estimate then start exactly one primary run using ${JSON.stringify({ prompts, targets: options.targets, repetitions: 1, project: suite, idempotency_key: suite, max_estimated_cost_usd: 0.5 })}. If estimate is unknown or exceeds $0.50, stop without starting. Poll get_run with wait_ms:10000 until terminal (at most 16 polls); then get_results with include_raw:false and list_runs. Retrieve every primary observation, summarize retrieved answers and source evidence without inventing facts. Exercise cancel_run on the completed primary run (no new run), then get_run to confirm results remain accessible. Make exactly one start_run call and never retry a paid run. Total provider observations must be <=10. If anything errors, report failure; do not substitute your own answer. End with run ID, result count, statuses, citations, and uncertainties.`;
}

async function findAgent(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  const paths = isAbsolute(binary)
    ? [binary]
    : (env.PATH ?? "").split(delimiter).map((directory) => join(directory, binary));
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      /* Try next PATH entry. */
    }
  }
  throw new Error("External agent executable was not found");
}

async function pages(getPage: (cursor?: number) => Promise<Results>): Promise<unknown[]> {
  const result: unknown[] = [];
  let cursor: number | undefined;
  do {
    const page = await getPage(cursor);
    result.push(...page.observations);
    if (
      page.next_cursor !== null &&
      (!Number.isInteger(page.next_cursor) || page.next_cursor <= (cursor ?? -1))
    )
      throw new Error("Invalid result cursor");
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return result;
}

async function reader(options: Options, env: NodeJS.ProcessEnv, database: string): Promise<Reader> {
  if (options.transport === "http") {
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(`${options.url}${path}`, {
        headers: { Authorization: `Bearer ${env.MCP_AUTH_TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Administrative verification HTTP ${response.status}`);
      return (await response.json()) as T;
    };
    return {
      audit: async () => (await get<{ toolCalls: AuditCall[] }>("/internal/audit")).toolCalls,
      run: (id) => get(`/internal/runs/${encodeURIComponent(id)}`),
      results: (id) =>
        pages((cursor) =>
          get(
            `/internal/runs/${encodeURIComponent(id)}/results?limit=100${cursor === undefined ? "" : `&cursor=${cursor}`}`,
          ),
        ),
      close: async () => {},
    };
  }
  const { ResearchStore } = (await import(pathToFileURL(options.storeModule).href)) as {
    ResearchStore: new (client: ReturnType<typeof createClient>, workspace: string) => Store;
  };
  const store = new ResearchStore(createClient({ url: `file:${database}` }), options.workspace);
  await store.initialize();
  return {
    audit: () => store.listToolCalls(),
    run: (id) => store.getRun(id),
    results: (id) => pages((cursor) => store.getResults({ run_id: id, limit: 100, cursor })),
    close: () => store.close(),
  };
}

async function verify(
  options: Options,
  env: NodeJS.ProcessEnv,
  database: string,
  evidence: Evidence,
  suite: string,
): Promise<{ runs: Run[]; observations: unknown[]; audit: AuditCall[] }> {
  if (
    evidence.runIds.length !== 1 ||
    evidence.calls.filter((call) => call.tool === "start_run").length !== 1
  )
    throw new Error("Expected exactly one native start_run and one returned run ID");
  const admin = await reader(options, env, database);
  try {
    const runs = await Promise.all(evidence.runIds.map((id) => admin.run(id)));
    if (
      runs.some(
        (run) =>
          run.input.project !== suite ||
          run.input.prompts.length !== (options.full ? 5 : 1) ||
          JSON.stringify(run.input.targets) !== JSON.stringify(options.targets),
      )
    )
      throw new Error("Server run does not match this acceptance suite");
    const observations = (await Promise.all(evidence.runIds.map((id) => admin.results(id)))).flat();
    const allAudit = await admin.audit();
    const startedAt = Number(suite.split("-")[1]);
    const audit = allAudit.filter(
      (call) =>
        Date.parse(call.created_at ?? "") >= startedAt &&
        (!call.run_id || evidence.runIds.includes(call.run_id)),
    );
    assertAcceptance(evidence, audit, observations);
    if (observations.length !== (options.full ? 5 : 1) * options.targets.length)
      throw new Error("Incomplete server results");
    return { runs, observations, audit };
  } finally {
    await admin.close();
  }
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function loadLedger(path: string): Promise<SpendLedger> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SpendLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { spentUsd: 0, entries: [] };
    throw error;
  }
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key]) => /TOKEN|SECRET|KEY|PASSWORD/.test(key))
    .map(([, value]) => value ?? "");
}

async function execute(
  options: Options,
  env: NodeJS.ProcessEnv,
  cwd: string,
  suite: string,
): Promise<{ evidence: Evidence; ok: boolean }> {
  const config = join(cwd, "mcp.json");
  const database = join(cwd, "research.db");
  await writeFile(config, JSON.stringify(makeMcpConfig(options, env, database)), { mode: 0o600 });
  const args = [
    "--bare",
    "--strict-mcp-config",
    "--mcp-config",
    config,
    "--tools",
    "",
    "--allowedTools",
    ...REQUIRED_TOOLS.map((tool) => `mcp__aeo__${tool}`),
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "24",
    "--max-budget-usd",
    "2",
    "--model",
    options.model,
    "-p",
    agentPrompt(options, suite),
  ];
  const secrets = secretValues(env);
  const child = await runChild(await findAgent(options.agentBin, env), args, {
    cwd,
    env: agentEnvironment(env, cwd),
    timeoutMs: 300_000,
    output: join(options.outputDir, `${suite}.transcript.jsonl`),
    secrets,
  });
  const evidence = parseTranscript(child.stdout);
  return { evidence, ok: child.exitCode === 0 && !child.timedOut && evidence.agentSucceeded };
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  const options = harnessOptions(args, env);
  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN)
    throw new Error(
      "Provide explicit agent authentication via ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN",
    );
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  const ledgerPath = join(options.outputDir, "cumulative-spend.json");
  const lock = `${ledgerPath}.lock`;
  await mkdir(lock);
  const cwd = await mkdtemp(join(tmpdir(), "opensenpai-agent-"));
  const suite = `e2e-${Date.now()}-${process.pid}`;
  let ledger: SpendLedger | undefined;
  let evidence: Evidence | undefined;
  try {
    ledger = reserveSpend(await loadLedger(ledgerPath), suite, 2, 1);
    await saveJson(ledgerPath, ledger);
    const execution = await execute(options, env, cwd, suite);
    evidence = execution.evidence;
    if (!execution.ok) throw new Error("External agent did not finish successfully");
    const verification = await verify(options, env, join(cwd, "research.db"), evidence, suite);
    const appCost = verification.runs.every((run) => run.estimated_cost_usd !== null)
      ? verification.runs.reduce(
          (sum, run) => sum + Math.max(run.estimated_cost_usd ?? 0, run.reported_cost_usd),
          0,
        )
      : null;
    ledger = accountSpend(ledger, suite, {
      agentSucceeded: true,
      agentCostUsd: evidence.agentCostUsd,
      appSucceeded: true,
      appCostUsd: appCost,
    });
    await saveJson(ledgerPath, ledger);
    await saveJson(
      join(options.outputDir, `${suite}.report.json`),
      redact(
        {
          suite,
          transport: options.transport,
          targets: options.targets,
          evidence,
          ...verification,
          spend: ledger,
          budgetNote:
            "Local reported/estimated accounting is not a vendor charge guarantee; failed or unknown outcomes retain full allowances.",
        },
        secretValues(env),
      ),
    );
    process.stdout.write(
      `Acceptance passed: ${suite}; cumulative accounted spend $${ledger.spentUsd.toFixed(4)}\n`,
    );
  } catch (error) {
    if (ledger?.entries.some((entry) => entry.id === suite && !entry.settled)) {
      ledger = accountSpend(ledger, suite, {
        agentSucceeded: false,
        agentCostUsd: evidence?.agentCostUsd ?? null,
        appSucceeded: false,
        appCostUsd: null,
      });
      await saveJson(ledgerPath, ledger);
    }
    throw error;
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Acceptance failed";
    process.stderr.write(
      `${JSON.stringify(redact({ error: { code: "ACCEPTANCE_FAILED", message: message.slice(0, 300) } }, secretValues(process.env)))}\n`,
    );
    process.exitCode = 1;
  });
}
