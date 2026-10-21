/**
 * Глобальная подготовка тестов: дожидается базы, создаёт тестовую базу и
 * накатывает миграции. Отдельная база — тесты не трогают демо-данные.
 *
 * Ретраи нужны по двум причинам:
 *  - в CI сервис Postgres стартует параллельно с прогоном и может быть ещё
 *    не готов (Prisma отвечает P1001 «Can't reach database server»);
 *  - на машине разработчика Postgres живёт в WSL2, и проброс порта иногда
 *    моргает на несколько секунд.
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ждём, пока база начнёт отвечать. */
async function waitForDatabase(url: string, attempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      await client.$queryRawUnsafe("SELECT 1");
      await client.$disconnect();
      return;
    } catch {
      await client.$disconnect().catch(() => undefined);
      if (attempt === attempts) {
        throw new Error(`База недоступна после ${attempts} попыток: ${url}`);
      }
      await sleep(1000);
    }
  }
}

/** Миграции с ретраями: P1001 — это сеть, а не ошибка миграции. */
async function migrateDeploy(url: string, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
      });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      const message = String(error);
      if (!/P1001|Can't reach database server/i.test(message)) throw error;
      console.warn(`[global-setup] БД недоступна (P1001), повтор через 2 с (попытка ${attempt})`);
      await sleep(2000);
    }
  }
}

export default async function globalSetup(): Promise<void> {
  const adminUrl = TEST_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, "/postgres$1");

  await waitForDatabase(adminUrl);

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

  await migrateDeploy(TEST_DATABASE_URL);
}
