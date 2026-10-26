/**
 * Setup-файл: поднимает окружение до того, как тесты импортируют src/config.ts.
 * Читает тот же .env, что и само приложение (src/infra/env-file.ts) — дубля парсера нет.
 */
import { loadEnvFile } from "../../src/infra/env-file.js";

loadEnvFile();

// Vitest (Vite) сам пишет свой MODE=test в окружение — это коллизия с нашим
// MODE=webhook|polling (транспорт MAX). В тестах транспорт по умолчанию webhook;
// режим polling тесты задают явным override в createHarness.
if (process.env.MODE === "test") {
  process.env.MODE = "webhook";
}
