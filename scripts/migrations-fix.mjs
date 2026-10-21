// Разовый помощник: добавить частичный уникальный индекс в сгенерированную миграцию.
// Prisma не умеет частичные индексы, поэтому их приходится дописывать руками.
//
// ВАЖНО: индекс дописывается в ту миграцию, где создаётся таблица Booking.
// Если дописать его в другую (например, последнюю по дате), при применении
// миграций с нуля индекс упадёт с «relation Booking does not exist».
// Защита от двойного добавления — проверка содержимого файла.
import { appendFileSync, readFileSync, readdirSync } from "node:fs";

const dirs = readdirSync("prisma/migrations").filter((d) => d !== "migration_lock.toml");
if (dirs.length === 0) throw new Error("Нет каталога миграции");

const indexSql =
  `\n-- Защита от второй активной записи на дисциплину (§13.8). Prisma не умеет частичные индексы.\n` +
  `CREATE UNIQUE INDEX "booking_active_one_per_discipline"\n` +
  `    ON "Booking" ("disciplineId", lower("studentFio"))\n` +
  `    WHERE "status" IN ('submitted', 'paid');\n`;

// Миграция, где создаётся таблица Booking.
const target = dirs
  .sort()
  .find((d) => readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8").includes('CREATE TABLE "Booking"'));

if (!target) {
  throw new Error(
    `Не нашёл миграцию с CREATE TABLE "Booking" среди: ${dirs.join(", ")}. Индекс дописывается вручную в неё.`,
  );
}

const file = `prisma/migrations/${target}/migration.sql`;
const existing = readFileSync(file, "utf8");
if (existing.includes("booking_active_one_per_discipline")) throw new Error("Индекс уже добавлен");

appendFileSync(file, indexSql);
console.log(`индекс добавлен в ${file}`);
