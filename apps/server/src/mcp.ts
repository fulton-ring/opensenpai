import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { ResearchError, runInputSchema } from "@opensenpai/core/contracts";
import type { ResearchService } from "@opensenpai/core/service";
import { z } from "zod";

/** Convert internal failures to actionable MCP errors without exposing secrets or stacks. */
export function publicError(error: unknown) {
  if (error instanceof ResearchError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof z.ZodError)
    return {
      code: "INVALID_INPUT",
      message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      retryable: false,
    };
  return {
    code: "INTERNAL_ERROR",
    message: "The operation could not complete. Retry or inspect the server's durable run status.",
    retryable: false,
  };
}
const id = z.string().min(1).max(160).describe("Durable run ID returned by start_run.");
const outputSchema = z.record(z.string(), z.unknown());
const runId = z.object({ run_id: id }).strict();
const discoveryInput = z
  .object({
    provider: z.string().min(1).max(80).optional(),
    model_query: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

function tool<S extends z.ZodType>(
  name: string,
  description: string,
  inputSchema: S,
  readOnly: boolean,
  execute: (input: z.output<S>) => Promise<unknown>,
) {
  return createTool({
    id: name,
    description,
    inputSchema,
    outputSchema,
    mcp: {
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: name === "cancel_run",
        idempotentHint: true,
        openWorldHint: name === "start_run",
      },
    },
    execute: async (input) => {
      try {
        return (await execute(input as z.output<S>)) as Record<string, unknown>;
      } catch (error) {
        return { error: publicError(error) };
      }
    },
  });
}

const resultsInput = runId.extend({
  target_id: z.string().min(1).max(80).optional(),
  prompt_id: z.string().min(1).max(80).optional(),
  status: z
    .enum(["pending", "running", "succeeded", "failed", "cancelled", "unknown_outcome"])
    .optional(),
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  include_raw: z.boolean().default(false),
});

const listInput = z
  .object({
    project: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    before: z
      .string()
      .max(100)
      .optional()
      .describe(
        "Legacy timestamp boundary; prefer cursor for complete pagination when timestamps tie.",
      ),
    cursor: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Opaque next_cursor returned by the preceding list_runs page."),
  })
  .strict();

/** Expose discovery and bounded experiments over the native Mastra MCP transport. */
export function createResearchMcp(service: ResearchService) {
  return new MCPServer({
    id: "opensenpai",
    name: "OpenSenpai Research",
    version: "0.1.0",
    instructions:
      "Discover model and retrieval providers with list_targets. Set provider and model_query to search a model catalog. Pass inline targets containing id, provider, model, and independent search configuration to estimate_run/start_run; named presets are optional. No code edits are needed to choose a model. Poll get_run and retrieve get_results. Budgets use server-owned pricing. Provider credentials and configuration cannot be changed through MCP.",
    tools: {
      list_targets: tool(
        "list_targets",
        "Discover registered model/retrieval providers and optional presets. Supply provider/model_query to read a provider's model catalog. No paid generation or search is performed.",
        discoveryInput,
        true,
        (query) => service.listTargets(query),
      ),
      estimate_run: tool(
        "estimate_run",
        "Estimate inline model/search experiments or optional presets using server-owned pricing. May read model metadata; performs no paid generation or search. Unpriced targets remain explicit.",
        runInputSchema,
        true,
        (input) => service.estimateRun(input),
      ),
      start_run: tool(
        "start_run",
        "Persist and enqueue a research run after validating all target availability and budget. Reuse idempotency_key for retries.",
        runInputSchema,
        false,
        (input) => service.startRun(input),
      ),
      get_run: tool(
        "get_run",
        "Read durable run status and counts, optionally waiting until a change or terminal status. Maximum wait is ten seconds.",
        runId.extend({ wait_ms: z.number().int().min(0).max(10_000).default(1_000) }),
        true,
        (input) => service.getRun(input),
      ),
      get_results: tool(
        "get_results",
        "Read a bounded page of normalized observations. Raw provider payloads are excluded unless include_raw is true.",
        resultsInput,
        true,
        (input) => service.getResults(input),
      ),
      list_runs: tool(
        "list_runs",
        "List recent durable runs by project with a stable next_cursor. Pass that cursor unchanged for the next page; before remains a legacy timestamp filter.",
        listInput,
        true,
        (input) => service.listRuns(input),
      ),
      cancel_run: tool(
        "cancel_run",
        "Request cancellation and stop pending observations. In-flight calls may already have incurred cost.",
        runId,
        false,
        (input) => service.cancelRun(input),
      ),
    },
  });
}
