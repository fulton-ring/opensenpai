import { globSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkStructure(paths: readonly string[]) {
  const violations: { directory: string; count: number }[] = [];
  const pending = paths.map((path) => resolve(path));
  const visited = new Set<string>();
  while (pending.length) {
    const directory = pending.pop();
    if (!directory || visited.has(directory)) continue;
    visited.add(directory);
    const entries = readdirSync(directory, { withFileTypes: true });
    const count = entries.filter((entry) => !entry.isDirectory()).length;
    if (count > 10) violations.push({ directory, count });
    for (const entry of entries) if (entry.isDirectory()) pending.push(join(directory, entry.name));
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const roots = globSync([
    "src",
    "tests",
    "scripts",
    "apps/*/src",
    "apps/*/tests",
    "packages/*/src",
    "packages/*/tests",
  ]);
  const violations = checkStructure(roots);
  for (const { directory, count } of violations)
    process.stderr.write(
      `${relative(process.cwd(), directory) || "."}: ${count} direct files (maximum 10)\n`,
    );
  if (violations.length) process.exitCode = 1;
}
