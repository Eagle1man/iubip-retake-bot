import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    setupFiles: ["./test/setup/env.ts"],
    globalSetup: "./test/setup/global.ts",
    // Файлы делят одну тестовую базу: параллельный запуск перемешал бы данные.
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/domain/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
