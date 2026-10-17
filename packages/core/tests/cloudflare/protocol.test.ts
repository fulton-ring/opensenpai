import { expect, it } from "vitest";
import { ResearchError } from "../../src/contracts.js";
import {
  deserializeResearchError,
  isResearchRequest,
  RESEARCH_METHODS,
  serializeResearchError,
} from "../../src/storage/protocol.js";

it("allows only the explicit research API and preserves typed failures", () => {
  expect(isResearchRequest({ method: "claim", args: ["observation", "owner"] })).toBe(true);
  for (const method of ["client", "close", "transaction", "constructor", "toString"])
    expect(isResearchRequest({ method, args: [] })).toBe(false);
  expect(isResearchRequest({ method: "claim", args: null })).toBe(false);
  expect(new Set(RESEARCH_METHODS).size).toBe(RESEARCH_METHODS.length);
  const error = new ResearchError("BUDGET_EXCEEDED", "Budget exhausted", false);
  expect(deserializeResearchError(serializeResearchError(error))).toMatchObject(error);
  expect(serializeResearchError(new Error("database details"))).toEqual({
    code: "STORAGE_ERROR",
    message: "Research storage operation failed",
    retryable: false,
  });
});
