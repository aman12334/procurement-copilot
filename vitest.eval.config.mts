import { defineConfig } from "vitest/config";
import path from "node:path";

// Offline evaluation harness (may read stage1/ground_truth). Never part of the runtime or `npm test`.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: { include: ["eval/**/*.eval.ts"], environment: "node", testTimeout: 900_000, hookTimeout: 900_000, fileParallelism: false },
});
