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
  expect(harnessOptions([], { OPENSENPAI_LIVE_TESTS: "1" }).targets).toMatchObject([
    {
      id: "experiment-1",
      provider: "openrouter",
      model: "openai/gpt-6-luna",
      search: { mode: "controlled", engine: "exa" },
    },
  ]);
  const env = {
    OPENSENPAI_LIVE_TESTS: "1",
    E2E_TARGETS: "router-exa",
    ANTHROPIC_API_KEY: "agent-key",
    OPENROUTER_API_KEY: "provider-key",
    MCP_AUTH_TOKEN: "server-token",
    HOME: "/real/home",
    XDG_CONFIG_HOME: "/real/config",
    CLAUDE_CONFIG_DIR: "/real/claude",
    CLAUDE_CODE_OAUTH_TOKEN: "ignored-oauth",
  };
  const options = harnessOptions([], env);
  expect(options.targets).toEqual(["router-exa"]);
  const isolated = agentEnvironment(env, "/tmp/isolated");
  expect(isolated.ANTHROPIC_API_KEY).toBe("agent-key");
  expect(isolated.OPENROUTER_API_KEY).toBeUndefined();
  expect(isolated.MCP_AUTH_TOKEN).toBeUndefined();
  expect(isolated.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(isolated.HOME).toBeUndefined();
  expect(isolated.XDG_CONFIG_HOME).toBeUndefined();
  expect(isolated.CLAUDE_CONFIG_DIR).toBe("/tmp/isolated/.claude");
  expect(env.HOME).toBe("/real/home");
  expect(env.XDG_CONFIG_HOME).toBe("/real/config");
  expect(env.CLAUDE_CONFIG_DIR).toBe("/real/claude");
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
      `#!${process.execPath}\nconst source=process.argv.indexOf("--setting-sources");if(source<0||process.argv[source+1]!==""||process.env.HOME||process.env.XDG_CONFIG_HOME)process.exit(8);process.stdout.write(${JSON.stringify(transcript(events))});\n`,
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
    await main(args, {
      ...env,
      E2E_AGENT_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "fixture-router-token",
    });
    ledger = JSON.parse(await readFile(join(artifactDir, "cumulative-spend.json"), "utf8"));
    expect(ledger.spentUsd).toBeCloseTo(2.06);
    const gatewayEntry = ledger.entries.at(-1);
    const gatewayReport = JSON.parse(
      await readFile(join(artifactDir, `${gatewayEntry.id}.report.json`), "utf8"),
    );
    expect(gatewayReport.agentProvider).toBe("openrouter");
    expect(gatewayReport.evidence.agentCostUsd).toBe(0.04);
    expect(gatewayEntry.chargedUsd).toBeCloseTo(2.01);
    expect(gatewayReport.allowances).toEqual({ agentUsd: 2, appUsd: 1 });
    await writeFile(
      cli,
      `#!${process.execPath}\nconst fs=require("node:fs");const args=process.argv;const budget=args[args.indexOf("--max-budget-usd")+1];const prompt=args[args.indexOf("-p")+1];const ledger=JSON.parse(fs.readFileSync(${JSON.stringify(join(artifactDir, "cumulative-spend.json"))},"utf8"));const entry=ledger.entries.at(-1);if(budget!=="0.4"||!prompt.includes('"max_estimated_cost_usd":0.2')||!prompt.includes("exceeds $0.2")||entry.agentAllowance!==0.4||entry.appAllowance!==0.2)process.exit(9);process.stdout.write(${JSON.stringify(transcript(events))});\n`,
    );
    await main(args, {
      ...env,
      E2E_AGENT_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "fixture-router-token",
      E2E_AGENT_BUDGET_USD: "0.4",
      E2E_APP_BUDGET_USD: "0.2",
    });
    ledger = JSON.parse(await readFile(join(artifactDir, "cumulative-spend.json"), "utf8"));
    expect(ledger.spentUsd).toBeCloseTo(2.47);
    const customEntry = ledger.entries.at(-1);
    expect(customEntry).toMatchObject({ agentAllowance: 0.4, appAllowance: 0.2 });
    expect(customEntry.chargedUsd).toBeCloseTo(0.41);
    const customReport = JSON.parse(
      await readFile(join(artifactDir, `${customEntry.id}.report.json`), "utf8"),
    );
    expect(customReport.allowances).toEqual({ agentUsd: 0.4, appUsd: 0.2 });
    expect(customReport.budgetNote).toContain("$0.4 allowance");
    await writeFile(
      cli,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(transcript([{ type: "result", total_cost_usd: 3, is_error: true }]))});\n`,
    );
    await expect(main(args, env)).rejects.toThrow(/agent did not finish/i);
    ledger = JSON.parse(await readFile(join(artifactDir, "cumulative-spend.json"), "utf8"));
    expect(ledger.spentUsd).toBeCloseTo(6.47);
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

it("requires API-key authentication because bare Claude ignores OAuth", async () => {
  const { main } = await import("../scripts/e2e-real-agent.js");
  await expect(
    main([], {
      OPENSENPAI_LIVE_TESTS: "1",
      E2E_TARGETS: "router-exa",
      CLAUDE_CODE_OAUTH_TOKEN: "not-supported-in-bare-mode",
    }),
  ).rejects.toThrow(/ANTHROPIC_API_KEY/);
});

it("isolates OpenRouter gateway authentication from the Anthropic account", async () => {
  const { harnessOptions, agentEnvironment } = await import("../scripts/e2e-real-agent.js");
  const env = {
    OPENSENPAI_LIVE_TESTS: "1",
    E2E_TARGETS: "router-exa",
    E2E_AGENT_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "router-agent-key",
    ANTHROPIC_API_KEY: "must-not-leak",
    ANTHROPIC_AUTH_TOKEN: "must-not-leak-either",
    ANTHROPIC_BASE_URL: "https://untrusted.invalid",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-must-not-leak",
  };
  expect(harnessOptions([], env).model).toBe("anthropic/claude-haiku-5.5");
  const isolated = agentEnvironment(env, "/tmp/isolated");
  expect(isolated.ANTHROPIC_AUTH_TOKEN).toBe("router-agent-key");
  expect(isolated.ANTHROPIC_API_KEY).toBe("");
  expect(isolated.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
  expect(isolated.OPENROUTER_API_KEY).toBeUndefined();
  expect(isolated.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(JSON.stringify(isolated)).not.toContain("must-not-leak");
  const direct = agentEnvironment({ ...env, E2E_AGENT_PROVIDER: "anthropic" }, "/tmp/isolated");
  expect(direct.ANTHROPIC_API_KEY).toBe("must-not-leak");
  expect(direct.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(direct.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(direct.OPENROUTER_API_KEY).toBeUndefined();
  expect(harnessOptions([], { ...env, E2E_AGENT_PROVIDER: "anthropic" }).model).toBe(
    "claude-haiku-5-5",
  );
});

it("rejects unknown agent providers and missing OpenRouter authentication before dispatch", async () => {
  const { main, agentEnvironment } = await import("../scripts/e2e-real-agent.js");
  expect(() => agentEnvironment({ E2E_AGENT_PROVIDER: "surprise" }, "/tmp/isolated")).toThrow(
    /provider/i,
  );
  expect(() =>
    agentEnvironment(
      { E2E_AGENT_PROVIDER: "openrouter", ANTHROPIC_API_KEY: "wrong-provider" },
      "/tmp/isolated",
    ),
  ).toThrow(/OPENROUTER_API_KEY/);
  await expect(
    main([], {
      OPENSENPAI_LIVE_TESTS: "1",
      E2E_TARGETS: "router-exa",
      E2E_AGENT_PROVIDER: "openrouter",
      ANTHROPIC_API_KEY: "wrong-provider",
    }),
  ).rejects.toThrow(/OPENROUTER_API_KEY/);
});

it("uses default and reduced positive spend allowances without raising reservation caps", async () => {
  const { harnessOptions } = await import("../scripts/e2e-real-agent.js");
  const env = { OPENSENPAI_LIVE_TESTS: "1", E2E_TARGETS: "router-exa" };
  const defaults = harnessOptions([], env);
  expect(defaults).toMatchObject({ agentAllowance: 2, appAllowance: 1 });
  expect(
    reserveSpend(
      { spentUsd: 0, entries: [] },
      "default",
      defaults.agentAllowance,
      defaults.appAllowance,
    ).spentUsd,
  ).toBe(3);
  const custom = harnessOptions([], {
    ...env,
    E2E_AGENT_BUDGET_USD: "0.5",
    E2E_APP_BUDGET_USD: "0.25",
  });
  expect(custom).toMatchObject({ agentAllowance: 0.5, appAllowance: 0.25 });
  const reserved = reserveSpend(
    { spentUsd: 8.2229494, entries: [] },
    "custom",
    custom.agentAllowance,
    custom.appAllowance,
  );
  expect(reserved.spentUsd).toBeCloseTo(8.9729494);
  expect(reserved.entries[0]).toMatchObject({ agentAllowance: 0.5, appAllowance: 0.25 });
  expect(() =>
    reserveSpend(
      { spentUsd: 8.2229494, entries: [] },
      "default",
      defaults.agentAllowance,
      defaults.appAllowance,
    ),
  ).toThrow(/budget/i);
});
it.each(["0", "-0.1", "NaN", "Infinity", "", "2.0001"])(
  "rejects invalid agent allowance %j before dispatch",
  async (value) => {
    const { harnessOptions } = await import("../scripts/e2e-real-agent.js");
    expect(() =>
      harnessOptions([], {
        OPENSENPAI_LIVE_TESTS: "1",
        E2E_TARGETS: "router-exa",
        E2E_AGENT_BUDGET_USD: value,
      }),
    ).toThrow(/E2E_AGENT_BUDGET_USD/);
  },
);
it.each(["0", "-0.1", "NaN", "Infinity", "", "1.0001"])(
  "rejects invalid application allowance %j before dispatch",
  async (value) => {
    const { harnessOptions } = await import("../scripts/e2e-real-agent.js");
    expect(() =>
      harnessOptions([], {
        OPENSENPAI_LIVE_TESTS: "1",
        E2E_TARGETS: "router-exa",
        E2E_APP_BUDGET_USD: value,
      }),
    ).toThrow(/E2E_APP_BUDGET_USD/);
  },
);

it.each([
  [0, 1],
  [2, 0],
  [-0.1, 1],
  [Number.NaN, 1],
  [2.0001, 1],
  [2, 1.0001],
])("rejects invalid spend reservations agent=%s app=%s", (agent, app) => {
  expect(() => reserveSpend({ spentUsd: 0, entries: [] }, "invalid", agent, app)).toThrow(
    /invalid/i,
  );
});

it("selects inline research models and independently chosen search without preset aliases", async () => {
  const { harnessOptions } = await import("../scripts/e2e-real-agent.js");
  const env = { OPENSENPAI_LIVE_TESTS: "1" };
  const options = harnessOptions(
    [
      "--research-model",
      "z-ai/glm-5.3-flash",
      "--research-model",
      "openai/gpt-6-luna",
      "--search-engine",
      "perplexity",
      "--research-provider",
      "openrouter",
      "--model",
      "agent-only-model",
    ],
    env,
  );
  expect(options.model).toBe("agent-only-model");
  expect(options.targets).toMatchObject([
    {
      id: "experiment-1",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      search: { mode: "server", engine: "perplexity", max_uses: 1 },
    },
    {
      id: "experiment-2",
      provider: "openrouter",
      model: "openai/gpt-6-luna",
      search: { mode: "server", engine: "perplexity", max_uses: 1 },
    },
  ]);
  expect(
    harnessOptions([], {
      ...env,
      E2E_RESEARCH_MODELS: "z-ai/glm-5.3-flash",
      E2E_SEARCH_ENGINE: "off",
      E2E_RESEARCH_PROVIDER: "customAdapter",
    }).targets,
  ).toMatchObject([
    { provider: "customAdapter", model: "z-ai/glm-5.3-flash", search: { mode: "off" } },
  ]);
  expect(harnessOptions(["--search-engine", "native"], env).targets).toMatchObject([
    { search: { mode: "native", max_uses: 1 } },
  ]);
  expect(harnessOptions(["--target", "operator-preset"], env).targets).toEqual(["operator-preset"]);
});
it.each([
  ["--research-model", ""],
  ["--research-model", "one", "--research-model", "two", "--research-model", "three"],
  ["--research-provider", "bad/provider"],
  ["--search-engine", "google"],
  ["--target", "preset", "--research-model", "inline"],
])("rejects invalid or ambiguous experiment selection %j", async (...args) => {
  const { harnessOptions } = await import("../scripts/e2e-real-agent.js");
  expect(() => harnessOptions(args, { OPENSENPAI_LIVE_TESTS: "1" })).toThrow();
});

it("verifies inline selections carried through an external agent prompt and native run evidence", async () => {
  const { chmod, writeFile, readdir } = await import("node:fs/promises");
  const { createServer } = await import("node:http");
  const { main } = await import("../scripts/e2e-real-agent.js");
  const dir = await mkdtemp(join(tmpdir(), "harness-inline-"));
  const artifactDir = join(dir, "artifacts");
  const selections = ["z-ai/glm-5.3-flash", "openai/gpt-6-luna"].map((model, index) => ({
    id: `experiment-${index + 1}`,
    provider: "openrouter",
    model,
    search: { mode: "server", engine: "perplexity", max_uses: 1 } as {
      mode: string;
      engine?: string;
      max_uses: number;
    },
    max_output_tokens: 512,
    timeout_ms: 120000,
  }));
  let mismatch = false;
  let nativeObserved = "unknown";
  const server = createServer((request, response) => {
    void (async () => {
      const ledger = JSON.parse(await readFile(join(artifactDir, "cumulative-spend.json"), "utf8"));
      const suite = ledger.entries.at(-1).id;
      const persisted = selections.map((target) =>
        Object.fromEntries(Object.entries(target).reverse()),
      );
      if (mismatch) persisted[0] = { ...persisted[0], model: "different-model" };
      const payload = request.url?.startsWith("/internal/audit")
        ? {
            toolCalls: tools.map((tool) => ({
              tool,
              run_id: "inline-run",
              created_at: new Date().toISOString(),
            })),
          }
        : request.url?.includes("/results")
          ? {
              observations: selections.map((target) => ({
                id: target.id,
                status: "succeeded",
                target: { id: target.id, search: target.search },
                result: {
                  answer: "Fixture evidence",
                  search_activity: { requested: target.search.mode, observed: nativeObserved },
                },
              })),
              next_cursor: null,
            }
          : {
              id: "inline-run",
              status: "succeeded",
              estimated_cost_usd: 0.01,
              reported_cost_usd: 0.005,
              input: { project: suite, prompts: [{}], targets: persisted },
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
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const cli = join(dir, "inline-agent");
    const source = () =>
      `#!${process.execPath}\nconst prompt=process.argv[process.argv.indexOf("-p")+1];const match=prompt.match(/using (\\{.*\\})\\. If estimate/);if(!match||!prompt.includes("Call list_targets with {}")||prompt.includes("and ensure"))process.exit(7);const input=JSON.parse(match[1]);if(JSON.stringify(input.targets)!==JSON.stringify(${JSON.stringify(selections)}))process.exit(8);const tools=${JSON.stringify(tools)};const events=tools.map(tool=>({type:"assistant",message:{content:[{type:"tool_use",id:tool,name:"mcp__aeo__"+tool,input:tool==="start_run"||tool==="estimate_run"?input:{}}]}}));events.push({type:"user",message:{content:[{type:"tool_result",tool_use_id:"start_run",content:[{type:"text",text:JSON.stringify({run:{id:"inline-run"}})}]}]}},{type:"result",total_cost_usd:0.04,is_error:false});process.stdout.write(events.map(event=>JSON.stringify(event)).join("\\n"));\n`;
    await writeFile(cli, source());
    await chmod(cli, 0o700);
    const args = [
      "--url",
      `http://127.0.0.1:${address.port}`,
      "--agent-bin",
      cli,
      "--output-dir",
      artifactDir,
      "--research-model",
      "z-ai/glm-5.3-flash",
      "--research-model",
      "openai/gpt-6-luna",
      "--search-engine",
      "perplexity",
    ];
    const env = {
      OPENSENPAI_LIVE_TESTS: "1",
      ANTHROPIC_API_KEY: "fixture-key",
      MCP_AUTH_TOKEN: "fixture-token",
      E2E_AGENT_BUDGET_USD: "0.4",
      E2E_APP_BUDGET_USD: "0.2",
    };
    await main(args, env);
    const reportName = (await readdir(artifactDir)).find((name) => name.endsWith(".report.json"));
    const report = JSON.parse(await readFile(join(artifactDir, reportName ?? "missing"), "utf8"));
    expect(report.targets).toEqual(selections);
    expect(
      report.evidence.calls.find((call: { tool: string }) => call.tool === "start_run").input
        .targets,
    ).toEqual(selections);
    mismatch = true;
    await expect(main(args, env)).rejects.toThrow(/run does not match/i);
    mismatch = false;
    for (const target of selections) target.search = { mode: "native", max_uses: 1 };
    await writeFile(cli, source());
    const nativeArgs = [...args];
    nativeArgs[nativeArgs.indexOf("--search-engine") + 1] = "native";
    await expect(main(nativeArgs, env)).rejects.toThrow(/native.*evidence/i);
    nativeObserved = "executed";
    await main(nativeArgs, env);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
