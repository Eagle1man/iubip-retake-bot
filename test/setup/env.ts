/**
 * Setup-файл: поднимает окружение до того, как тесты импортируют src/config.ts.
 * Читает тот же .env, что и само приложение (src/infra/env-file.ts) — дубля парсера нет.
 */
import { loadEnvFile } from "../../src/infra/env-file.js";

loadEnvFile();
