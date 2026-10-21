/**
 * Глобальная подготовка тестов: создаёт тестовую базу и накатывает миграции.
 * Отдельная база — тесты не трогают демо-данные.
 */
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { loadEnvFile } from "../../src/infra/env-file.js";

// Глобальный setup не гоняет setupFiles — окружение поднимаем сами,
// иначе DATABASE_URL_TEST из .env не виден и база ищется по дефолту.
loadEnvFile();

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  "postgresql://iubip:iubip@localhost:5432/iubip_retake_test";

export default async function globalSetup(): Promise<void> {
  const adminUrl = TEST_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, "/postgres$1");

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${new URL(TEST_DATABASE_URL).pathname.slice(1)}"`,
    );
  } catch (error) {
    if (!/already exists/.test(String(error))) throw error;
  } finally {
    await admin.$disconnect();
  }

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
