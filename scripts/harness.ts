import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

/** Native MCP tools required in both the agent transcript and the server audit for acceptance. */
export const REQUIRED_TOOLS = [
  "list_targets",
  "start_run",
  "get_run",
  "get_results",
  "list_runs",
  "cancel_run",
] as const;
/** Server-side audit record correlating an MCP tool invocation with its research run. */
export type AuditCall = { tool: string; run_id?: string | null; created_at?: string };
type NativeCall = { tool: string; id: string; input: Record<string, unknown> };
/** Parsed native tool events, returned run IDs, and the external agent's reported outcome and cost. */
export type Evidence = {
  calls: NativeCall[];
  runIds: string[];
  agentCostUsd: number | null;
  agentSucceeded: boolean;
};
/** One suite's reserved agent/application allowances and its eventual conservative charge. */
export type SpendEntry = {
  id: string;
  agentAllowance: number;
  appAllowance: number;
  chargedUsd: number;
  settled: boolean;
};
/** Cumulative accounted spend and suite reservations used to enforce the dispatch stop. */
export type SpendLedger = { spentUsd: number; entries: SpendEntry[] };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function resultRunIds(content: unknown): string[] {
  const blocks = Array.isArray(content) ? content : [{ text: content }];
  return blocks.flatMap((block: unknown) => {
    try {
      const result = object(JSON.parse(String(object(block).text)));
      const id = object(result.run).id;
      return typeof id === "string" ? [id] : [];
    } catch {
      return [];
    }
  });
}

function parseBlock(type: unknown, block: Record<string, unknown>, evidence: Evidence): void {
  if (type === "assistant" && block.type === "tool_use") {
    const name = String(block.name);
    const tool = name.replace(/^mcp__aeo__/, "");
    if (
      !name.startsWith("mcp__aeo__") ||
      !REQUIRED_TOOLS.includes(tool as (typeof REQUIRED_TOOLS)[number])
    ) {
      throw new Error(`Unexpected agent tool: ${name}`);
    }
    evidence.calls.push({ tool, id: String(block.id), input: object(block.input) });
  }
  if (
    type === "user" &&
    block.type === "tool_result" &&
    !block.is_error &&
    evidence.calls.some((call) => call.id === block.tool_use_id && call.tool === "start_run")
  ) {
    evidence.runIds.push(...resultRunIds(block.content));
  }
}

function parseEvent(event: Record<string, unknown>, evidence: Evidence): void {
  const content = object(event.message).content;
  if (Array.isArray(content))
    for (const block of content) parseBlock(event.type, object(block), evidence);
  if (event.type === "result") {
    evidence.agentCostUsd =
      typeof event.total_cost_usd === "number" &&
      Number.isFinite(event.total_cost_usd) &&
      event.total_cost_usd >= 0
        ? event.total_cost_usd
        : null;
    evidence.agentSucceeded =
      (event.is_error === false && event.subtype === undefined) ||
      (event.is_error === false && event.subtype === "success");
  }
}

/** Parse native JSONL agent output, rejecting malformed events and unexpected tools. */
export function parseTranscript(transcript: string): Evidence {
  const evidence: Evidence = { calls: [], runIds: [], agentCostUsd: null, agentSucceeded: false };
  for (const line of transcript.split("\n").filter((line) => line.trim())) {
    let event: Record<string, unknown>;
    try {
      event = object(JSON.parse(line));
    } catch {
      throw new Error("Invalid JSON agent transcript");
    }
    parseEvent(event, evidence);
  }
  evidence.runIds = [...new Set(evidence.runIds)];
  return evidence;
}

/** Require audited native tool use, matching run IDs, and successful observations containing answers. */
export function assertAcceptance(
  evidence: Evidence,
  audit: AuditCall[],
  observations: unknown[],
): void {
  for (const tool of REQUIRED_TOOLS) {
    if (!evidence.calls.some((call) => call.tool === tool))
      throw new Error(`Missing native agent tool call: ${tool}`);
    if (!audit.some((call) => call.tool === tool))
      throw new Error(`Missing server audit call: ${tool}`);
  }
  for (const id of evidence.runIds) {
    for (const tool of ["get_run", "get_results", "cancel_run"]) {
      if (!audit.some((call) => call.tool === tool && call.run_id === id)) {
        throw new Error(`Missing run-scoped audit record: ${tool}`);
      }
    }
  }
  if (
    !observations.length ||
    observations.some(
      (item) => object(item).status !== "succeeded" || !object(object(item).result).answer,
    )
  ) {
    throw new Error("Acceptance requires succeeded observations with answers");
  }
}

/** Remove nested credentials, bearer tokens, and configured secret values while preserving numeric token usage. */
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") {
    let result = value.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]");
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
      result = result.split(secret).join("[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(?:token|secret|password|authorization|api[_-]?key|credential)/i.test(key) &&
        !(
          /^(?:input|output|reasoning|cached|total|max_output)_tokens$/.test(key) &&
          typeof item === "number"
        )
          ? "[REDACTED]"
          : redact(item, secrets),
      ]),
    );
  return value;
}

/** Redact each JSONL event structurally, including secrets absent from the configured environment. */
export function redactTranscript(text: string, secrets: string[] = []): string {
  return text
    .split("\n")
    .map((line) => {
      try {
        return JSON.stringify(redact(JSON.parse(line), secrets));
      } catch {
        return String(redact(line, secrets));
      }
    })
    .join("\n");
}

function spendAllowance(name: string, value: string | undefined, maximum: number): number {
  const allowance = value === undefined ? maximum : Number(value);
  if (!Number.isFinite(allowance) || allowance <= 0 || allowance > maximum)
    throw new Error(`${name} must be finite, positive, and at most ${maximum}`);
  return allowance;
}

/** Read positive agent/application allowances, defaulting to $2/$1 and rejecting increases above those limits. */
export function spendAllowances(env: NodeJS.ProcessEnv): {
  agentAllowance: number;
  appAllowance: number;
} {
  return {
    agentAllowance: spendAllowance("E2E_AGENT_BUDGET_USD", env.E2E_AGENT_BUDGET_USD, 2),
    appAllowance: spendAllowance("E2E_APP_BUDGET_USD", env.E2E_APP_BUDGET_USD, 1),
  };
}

/** Reserve allowances before dispatch and reject reservations that would exceed the cumulative $10 stop. */
export function reserveSpend(
  ledger: SpendLedger,
  id: string,
  agentAllowance: number,
  appAllowance: number,
): SpendLedger {
  if (
    ![ledger.spentUsd, agentAllowance, appAllowance].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) ||
    agentAllowance <= 0 ||
    appAllowance <= 0 ||
    agentAllowance > 2 ||
    appAllowance > 1 ||
    ledger.entries.some((entry) => entry.id === id)
  )
    throw new Error("Invalid spend reservation");
  const allowance = agentAllowance + appAllowance;
  if (ledger.spentUsd + allowance > 10)
    throw new Error("Cumulative dispatch budget would exceed $10; $5 remains reserved");
  return {
    spentUsd: ledger.spentUsd + allowance,
    entries: [
      ...ledger.entries,
      { id, agentAllowance, appAllowance, chargedUsd: allowance, settled: false },
    ],
  };
}

/** Reconcile a reservation, retaining full allowances for unknown or failed work and all reported overruns. */
export function accountSpend(
  ledger: SpendLedger,
  id: string,
  outcome: {
    agentSucceeded: boolean;
    agentCostUsd: number | null;
    appSucceeded: boolean;
    appCostUsd: number | null;
  },
): SpendLedger {
  const entry = ledger.entries.find((entry) => entry.id === id);
  if (!entry || entry.settled) throw new Error("Unknown or settled spend reservation");
  const charge = (succeeded: boolean, cost: number | null, allowance: number) => {
    const known = cost !== null && Number.isFinite(cost) && cost >= 0 ? cost : null;
    return succeeded && known !== null ? known : Math.max(allowance, known ?? 0);
  };
  const chargedUsd =
    charge(outcome.agentSucceeded, outcome.agentCostUsd, entry.agentAllowance) +
    charge(outcome.appSucceeded, outcome.appCostUsd, entry.appAllowance);
  return {
    spentUsd: ledger.spentUsd - entry.chargedUsd + chargedUsd,
    entries: ledger.entries.map((item) =>
      item.id === id ? { ...item, chargedUsd, settled: true } : item,
    ),
  };
}

function stopGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Capture an isolated CLI process group, redact its artifact, and terminate descendants on timeout. */
export async function runChild(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    output: string;
    secrets?: string[];
  },
): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    stopGroup(child.pid, "SIGTERM");
    escalation = setTimeout(() => stopGroup(child.pid, "SIGKILL"), 500);
    escalation.unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const append = (text: string, stream: "stdout" | "stderr") => {
    if (stream === "stdout") stdout += text;
    else stderr += text;
    if (stdout.length + stderr.length > 10_000_000) stop();
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => append(chunk, "stdout"));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => append(chunk, "stderr"));
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await writeFile(options.output, `${redactTranscript(stdout, options.secrets)}\n`, {
      mode: 0o600,
    });
    return { exitCode, timedOut, stdout, stderr: String(redact(stderr, options.secrets)) };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    stopGroup(child.pid, "SIGKILL");
  }
}
