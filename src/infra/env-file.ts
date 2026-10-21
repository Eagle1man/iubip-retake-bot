import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Чтение .env в process.env.
 *
 * Ни `tsx`, ни `node`, ни vitest сами файл окружения не читают — без этого
 * `npm run dev` падал на «DATABASE_URL: Required», хотя .env лежит рядом.
 * Переменные окружения приоритетнее файла: в Docker/.env нет вовсе, а
 * тесты подставляют своё окружение до импорта конфига.
 */
export function loadEnvFile(path = ".env"): void {
  const file = resolve(process.cwd(), path);
  if (!existsSync(file)) return;

  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
