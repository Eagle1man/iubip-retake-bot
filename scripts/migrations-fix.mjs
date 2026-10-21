// Разовый помощник: добавить частичный уникальный индекс в сгенерированную миграцию.
// Prisma не умеет частичные индексы, поэтому их приходится дописывать руками.
import { appendFileSync, readFileSync, readdirSync } from "node:fs";

const dirs = readdirSync("prisma/migrations").filter((d) => d !== "migration_lock.toml");
if (dirs.length === 0) throw new Error("Нет каталога миграции");
const dir = dirs.sort().at(-1);
const file = `prisma/migrations/${dir}/migration.sql`;

const existing = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
if (existing.includes("booking_active_one_per_discipline")) throw new Error("Индекс уже добавлен");

appendFileSync(
  file,
  `\n-- Защита от второй активной записи на дисциплину (§13.8). Prisma не умеет частичные индексы.\n` +
    `CREATE UNIQUE INDEX "booking_active_one_per_discipline"\n` +
    `    ON "Booking" ("disciplineId", lower("studentFio"))\n` +
    `    WHERE "status" IN ('submitted', 'paid');\n`,
);
console.log(`индекс добавлен в ${file}`);
