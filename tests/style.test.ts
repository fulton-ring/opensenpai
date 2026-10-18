import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { analyzeStyle, checkStyle } from "../scripts/check-style.js";

const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function rules(source: string) {
  return analyzeStyle("fixture.ts", source).map((violation) => violation.rule);
}

it("requires JSDoc on exported definitions without guessing documentation quality", () => {
  const declarations = [
    "export function run() {}",
    "export class Runner {}",
    "export interface Input {}",
    "export type Input = string;",
    "export const ready = true;",
    "export enum State { Ready }",
    "export default function () {}",
    "export default () => 1;",
    "export default runner;",
    "export = runner;",
  ];
  for (const source of declarations) {
    expect(rules(source)).toEqual(["public-jsdoc"]);
    expect(rules(`/** Describes the public contract. */\n${source}`)).toEqual([]);
  }
  expect(rules("/** */\nexport const value = 1;")).toEqual([]);
  expect(rules("// Normal comment.\nexport function run() {}")).toEqual(["public-jsdoc"]);
});

it("exempts export lists and barrel reexports and does not require class-member documentation", () => {
  expect(
    rules(`export { local };
export { remote } from "./remote.js";
export * from "./remote.js";
export type { Input } from "./types.js";
/** Public runner. */
export class Runner { execute() {} }`),
  ).toEqual([]);
});

it("requires exactly one blank line between adjacent function implementations", () => {
  expect(rules("function first() {}\nfunction second() {}")).toEqual(["function-spacing"]);
  expect(rules("function first() {}\n\nfunction second() {}")).toEqual([]);
  expect(rules("function first() {}\n\n\nfunction second() {}")).toEqual(["function-spacing"]);
  expect(rules("const first = () => 1;\nconst second = function () {};")).toEqual([
    "function-spacing",
  ]);
  expect(rules("const first = (() => 1) satisfies Function;\n\nconst second = () => 2;")).toEqual(
    [],
  );
  expect(rules("function first() {} function second() {}")).toEqual(["function-spacing"]);
});

it("anchors spacing before the next function's documentation and leading comments", () => {
  expect(rules("function first() {}\n\n/** Second function. */\nfunction second() {}")).toEqual([]);
  expect(rules("function first() {}\n/** Second function. */\n\nfunction second() {}")).toEqual([
    "function-spacing",
  ]);
  expect(
    rules("function first() {} // First function.\n\n// Second function.\nfunction second() {}"),
  ).toEqual([]);
  expect(
    rules("function first() {}\n\n// Second function.\n/** Contract. */\nfunction second() {}"),
  ).toEqual([]);
});

it("checks adjacent constructors, methods, accessors, and nested sibling functions", () => {
  expect(
    rules("class Runner { constructor() {}\nrun() {}\n\nget ready() { return true; } }"),
  ).toEqual(["function-spacing"]);
  expect(rules("function outer() { function first() {}\nfunction second() {} }")).toEqual([
    "function-spacing",
  ]);
  expect(rules("class Runner { run(value: string): void;\nrun(value: string) {} }")).toEqual([]);
});

it("ignores callback spacing, ordinary statements, strings, and comments", () => {
  expect(
    rules(`const text = "export function undocumented() {}";
// export function undocumented() {}
items.map(() => {});
items.map(() => {});
const object = { first: () => {}, second: () => {} };
function first() { /* export const hidden = 1; */ }
const unrelated = 1;
function second() {}`),
  ).toEqual([]);
});

it("discovers only maintained source, scripts, and application configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "opensenpai-style-"));
  fixtures.push(root);
  const included = [
    "apps/server/src/main.ts",
    "packages/core/src/nested/model.ts",
    "scripts/check.ts",
    "config/providers/router.mjs",
    "config/search.js",
    "opensenpai.config.mjs",
  ];
  const excluded = [
    "tests/example.ts",
    "packages/core/tests/example.ts",
    "apps/server/dist/generated.ts",
    "apps/server/src/generated/example.ts",
    "apps/server/src/example.test.ts",
    ".worktrees/other/apps/server/src/main.ts",
    "node_modules/library/src/main.ts",
    "docs/example.ts",
  ];
  for (const file of [...included, ...excluded]) {
    const path = join(root, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "export function undocumented() {}\n");
  }
  const violations = checkStyle(root);
  expect(violations.map((violation) => violation.file).sort()).toEqual(included.sort());
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../scripts/check-style.ts", import.meta.url)),
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("apps/server/src/main.ts:1:public-jsdoc:");
});
