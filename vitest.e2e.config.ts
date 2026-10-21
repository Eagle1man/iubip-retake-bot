import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/e2e/**/*.test.ts"],
    setupFiles: ["./test/setup/env.ts"],
    globalSetup: "./test/setup/global.ts",
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
