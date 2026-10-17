import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { checkStructure } from "../scripts/check-structure.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(files: number) {
  const root = mkdtempSync(join(tmpdir(), "opensenpai-structure-"));
  fixtures.push(root);
  const source = join(root, "src");
  mkdirSync(source);
  for (let index = 0; index < files; index++) writeFileSync(join(source, `${index}.ts`), "");
  return { root, source };
}
it("accepts ten direct files and rejects eleven with the actual directory count", () => {
  const { source } = fixture(10);
  expect(checkStructure([source])).toEqual([]);
  writeFileSync(join(source, "eleventh.ts"), "");
  expect(checkStructure([source])).toEqual([{ directory: source, count: 11 }]);
});
it("counts nested directories independently and does not count directories as files", () => {
  const { source } = fixture(10);
  const nested = join(source, "dist");
  mkdirSync(nested);
  for (let index = 0; index < 10; index++) writeFileSync(join(nested, `${index}.ts`), "");
  expect(checkStructure([source, nested])).toEqual([]);
  writeFileSync(join(nested, "eleventh.ts"), "");
  expect(checkStructure([source, nested])).toEqual([{ directory: nested, count: 11 }]);
});
it("CLI discovers source roots and exits nonzero with a useful folder diagnostic", () => {
  const { root } = fixture(11);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/check-structure.ts", import.meta.url))],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("src: 11 direct files (maximum 10)");
});

it("CLI includes workspace source/test roots and leaves root configuration files exempt", () => {
  const { root } = fixture(0);
  const appTests = join(root, "apps", "server", "tests");
  const coreSource = join(root, "packages", "core", "src");
  mkdirSync(appTests, { recursive: true });
  mkdirSync(coreSource, { recursive: true });
  for (let index = 0; index < 11; index++) {
    writeFileSync(join(root, `${index}.json`), "{}");
    writeFileSync(join(coreSource, `${index}.ts`), "");
    if (index < 10) writeFileSync(join(appTests, `${index}.test.ts`), "");
  }
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/check-structure.ts", import.meta.url))],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe("packages/core/src: 11 direct files (maximum 10)");
});
