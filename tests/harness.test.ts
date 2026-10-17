import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountSpend,
  assertAcceptance,
  parseTranscript,
  redact,
  reserveSpend,
  runChild,
} from "../scripts/harness.js";

const native = (tool: string, id = tool, input = {}) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: `mcp__aeo__${tool}`, input }] },
});
const tools = [
  "list_targets",
  "estimate_run",
  "start_run",
  "get_run",
  "get_results",
  "list_runs",
  "cancel_run",
];
const transcript = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("real agent evidence", () => {
  it("requires native tool events and cross-checks every required tool against server audit", () => {
    const evidence = parseTranscript(transcript(tools.map((tool) => native(tool))));
    const audit = tools.map((tool) => ({ tool, run_id: "r1" }));
    expect(() =>
      assertAcceptance(evidence, audit, [
        {
          id: "o1",
          status: "succeeded",
          result: { answer: "Evidence", usage: { reported_cost_usd: 0.01 } },
        },
      ]),
    ).not.toThrow();
    expect(() => assertAcceptance(evidence, audit.slice(1), [])).toThrow(/audit.*list_targets/i);
    expect(() =>
      assertAcceptance(parseTranscript('{"type":"result","result":"called all tools"}'), audit, []),
    ).toThrow(/native.*list_targets/i);
  });

  it("rejects spoofed events, unknown MCP tools, malformed output, and unsuccessful results", () => {
    expect(
      parseTranscript(
        transcript([
          {
            type: "user",
            message: { content: [{ type: "tool_use", name: "mcp__aeo__start_run" }] },
          },
        ]),
      ).calls,
    ).toHaveLength(0);
    expect(() => parseTranscript(transcript([native("shell")]))).toThrow(/unexpected.*tool/i);
    expect(() => parseTranscript("not json")).toThrow(/invalid.*transcript/i);
    const evidence = parseTranscript(transcript(tools.map((tool) => native(tool))));
    expect(() =>
      assertAcceptance(
        evidence,
        tools.map((tool) => ({ tool })),
        [{ status: "failed" }],
      ),
    ).toThrow(/succeeded/i);
  });

  it("extracts run IDs only from structured tool results and reads the final agent charge", () => {
    const evidence = parseTranscript(
      transcript([
        native("start_run", "t1"),
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  { type: "text", text: JSON.stringify({ run: { id: "r1" }, created: true }) },
                ],
              },
            ],
          },
        },
        { type: "result", total_cost_usd: 0.04, is_error: false },
      ]),
    );
    expect(evidence.runIds).toEqual(["r1"]);
    expect(evidence.agentCostUsd).toBe(0.04);
    expect(evidence.agentSucceeded).toBe(true);
  });
});

it("redacts nested secret fields, bearer strings, and exact configured secrets", () => {
  const value = {
    token: "abc",
    nested: [{ authorization: "Bearer abc", text: "secret-value and Bearer abc", safe: 7 }],
    api_key: "another",
  };
  expect(redact(value, ["secret-value"])).toEqual({
    token: "[REDACTED]",
    nested: [{ authorization: "[REDACTED]", text: "[REDACTED] and Bearer [REDACTED]", safe: 7 }],
    api_key: "[REDACTED]",
  });
});

it("reserves cumulative spend before launch and charges unknown or failed work its full allowance", () => {
  const reserved = reserveSpend({ spentUsd: 6, entries: [] }, "suite", 2, 1);
  expect(reserved.spentUsd).toBe(9);
  expect(() => reserveSpend(reserved, "next", 2, 1)).toThrow(/budget/i);
  expect(
    accountSpend(reserved, "suite", {
      agentSucceeded: true,
      agentCostUsd: 0.2,
      appSucceeded: true,
      appCostUsd: 0.1,
    }).spentUsd,
  ).toBeCloseTo(6.3);
  expect(
    accountSpend(reserved, "suite", {
      agentSucceeded: false,
      agentCostUsd: 0.1,
      appSucceeded: false,
      appCostUsd: 0,
    }).spentUsd,
  ).toBe(9);
  expect(() => reserveSpend({ spentUsd: Number.NaN, entries: [] }, "x", 2, 1)).toThrow(/invalid/i);
});

it("captures subprocess exit without inheriting caller secrets and kills timeout process groups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-test-"));
  try {
    const output = join(dir, "out.jsonl");
    const result = await runChild(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({env:process.env.SHOULD_NOT_LEAK}));process.exit(3)",
      ],
      { cwd: dir, env: {}, timeoutMs: 2000, output },
    );
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({});
    const timed = await runChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      cwd: dir,
      env: {},
      timeoutMs: 30,
      output,
    });
    expect(timed.timedOut).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses accidental paid runs and isolates agent auth from service credentials", async () => {
  const { harnessOptions, agentEnvironment, makeMcpConfig } = await import(
    "../scripts/e2e-real-agent.js"
  );
  expect(() => harnessOptions([], {})).toThrow(/OPENSENPAI_LIVE_TESTS/);
  expect(() => harnessOptions([], { OPENSENPAI_LIVE_TESTS: "1" })).toThrow(/target/i);
  const env = {
    OPENSENPAI_LIVE_TESTS: "1",
    E2E_TARGETS: "router-exa",
    ANTHROPIC_API_KEY: "agent-key",
    OPENROUTER_API_KEY: "provider-key",
    MCP_AUTH_TOKEN: "server-token",
  };
  const options = harnessOptions([], env);
  expect(options.targets).toEqual(["router-exa"]);
  const isolated = agentEnvironment(env, "/tmp/isolated");
  expect(isolated.ANTHROPIC_API_KEY).toBe("agent-key");
  expect(isolated.OPENROUTER_API_KEY).toBeUndefined();
  expect(isolated.MCP_AUTH_TOKEN).toBeUndefined();
  expect(isolated.HOME).toBe("/tmp/isolated");
  const http = makeMcpConfig(options, env, "/tmp/db");
  expect(JSON.stringify(http)).toContain("server-token");
  expect(JSON.stringify(http)).not.toContain("provider-key");
});

it("redacts unknown nested secrets in JSONL artifacts", async () => {
  const { redactTranscript } = await import("../scripts/harness.js");
  expect(redactTranscript('{"nested":{"api_key":"not-in-env"}}')).toBe(
    '{"nested":{"api_key":"[REDACTED]"}}',
  );
});

it("retains actual reported overruns even when the external agent fails", () => {
  const ledger = reserveSpend({ spentUsd: 0, entries: [] }, "failed", 2, 1);
  expect(
    accountSpend(ledger, "failed", {
      agentSucceeded: false,
      agentCostUsd: 3,
      appSucceeded: false,
      appCostUsd: null,
    }).spentUsd,
  ).toBe(4);
});

it("runs deterministic CLI fixtures through HTTP verification and persists failed-agent overrun charges", async () => {
  const { chmod, readdir, writeFile } = await import("node:fs/promises");
  const { createServer } = await import("node:http");
  const { main } = await import("../scripts/e2e-real-agent.js");
  const dir = await mkdtemp(join(tmpdir(), "harness-orchestration-"));
  const artifactDir = join(dir, "artifacts");
  const server = createServer((request, response) => {
    void (async () => {
      expect(request.headers.authorization).toBe("Bearer fixture-server-token");
      const ledger = JSON.parse(await readFile(join(artifactDir, "cumulative-spend.json"), "utf8"));
      const suite = ledger.entries.at(-1).id;
      const payload = request.url?.startsWith("/internal/audit")
        ? {
            toolCalls: tools.map((tool) => ({
              tool,
              run_id: "run1",
              created_at: new Date().toISOString(),
            })),
          }
        : request.url?.includes("/results")
          ? {
              observations: [
                {
                  id: "o1",
                  status: "succeeded",
                  result: { answer: "Public evidence", api_key: "nested-fixture-secret" },
                },
              ],
              next_cursor: null,
            }
          : {
              id: "run1",
              status: "succeeded",
              estimated_cost_usd: 0.01,
              reported_cost_usd: 0.005,
              input: { project: suite, prompts: [{}], targets: ["router-exa"] },
            };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(payload));
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test listener");
    const cli = join(dir, "fixture-agent");
    const events = [
      ...tools.map((tool) => native(tool)),
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "start_run",
              content: [
                { type: "text", text: JSON.stringify({ run: { id: "run1" }, created: true }) },
              ],
            },
          ],
        },
      },
      { type: "result", total_cost_usd: 0.04, is_error: false },
    ];
    await writeFile(
      cli,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(transcript(events))});\n`,
    );
    await chmod(cli, 0o700);
    const env = {
      OPENSENPAI_LIVE_TESTS: "1",
      E2E_TARGETS: "router-exa",
      ANTHROPIC_API_KEY: "fixture-agent-token",
      MCP_AUTH_TOKEN: "fixture-server-token",
    };
    const args = [
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--agent-bin",
      cli,
      "--output-dir",
      artifactDir,
    ];
    await main(args, env);
    let ledger = JSON.parse(await readFile(join(artifactDir, "cumulative-spend.json"), "utf8"));
    expect(ledger.spentUsd).toBeCloseTo(0.05);
    const reportName = (await readdir(artifactDir)).find((name) => name.endsWith(".report.json"));
    expect(await readFile(join(artifactDir, reportName ?? "missing"), "utf8")).not.toContain(
      "nested-fixture-secret",
    );
    await writeFile(
      cli,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(transcript([{ type: "result", total_cost_usd: 3, is_error: true }]))});\n`,
    );
    await expect(main(args, env)).rejects.toThrow(/agent did not finish/i);
    ledger = JSON.parse(await readFile(join(artifactDir, "cumulative-spend.json"), "utf8"));
    expect(ledger.spentUsd).toBeCloseTo(4.05);
    expect((await readdir(artifactDir)).some((name) => name.endsWith(".lock"))).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps numeric token usage available in redacted evidence", () => {
  expect(redact({ usage: { input_tokens: 12, output_tokens: 3 }, access_token: "secret" })).toEqual(
    { usage: { input_tokens: 12, output_tokens: 3 }, access_token: "[REDACTED]" },
  );
});

it("requires run-scoped audit records for returned run IDs", () => {
  const evidence = parseTranscript(transcript(tools.map((tool) => native(tool))));
  evidence.runIds = ["r1"];
  expect(() =>
    assertAcceptance(
      evidence,
      tools.map((tool) => ({ tool, run_id: "different-run" })),
      [{ status: "succeeded", result: { answer: "answer" } }],
    ),
  ).toThrow(/run.*audit/i);
});

it("terminates grandchildren when an external CLI times out", async () => {
  const { writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "harness-process-group-"));
  try {
    const pidPath = join(dir, "grandchild.pid");
    const fixture = join(dir, "parent.cjs");
    await writeFile(
      fixture,
      `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},1000);`,
    );
    const result = await runChild(process.execPath, [fixture], {
      cwd: dir,
      env: {},
      timeoutMs: 150,
      output: join(dir, "transcript.jsonl"),
    });
    expect(result.timedOut).toBe(true);
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
