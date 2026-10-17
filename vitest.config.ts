import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules/**", ".worktrees/**", "dist/**"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
