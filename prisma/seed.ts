/**
 * Идемпотентный сид демо-данных для MVP «Запись на пересдачу».
 * Повторный запуск не падает: дисциплины/преподаватели/роли — upsert,
 * сессия — поиск по существующей открытой, запись — upsert по паре
 * (paymentToken, slotId).
 *
 * В конце печатает:
 *   DEEP_LINK=rt_<disciplineId>_<slotId>   (формат парсит parsePayload в src/bot/handlers/start.ts)
 *   SEED_PAYMENT_TOKEN=pay_seed_0001
 */

import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** tsx сам не подгружает .env — подгружаем вручную (shell-переменные приоритетнее). */
function loadEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

const prisma = new PrismaClient();

const NOW = new Date();

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

async function main(): Promise<void> {
  // 1. Дисциплины — идемпотентно по уникальному имени.
  const math = await prisma.discipline.upsert({
    where: { name: "Математический анализ" },
    update: {},
    create: { name: "Математический анализ", code: "MA" },
  });
  await prisma.discipline.upsert({
    where: { name: "Программирование на Python" },
    update: {},
    create: { name: "Программирование на Python", code: "PY" },
  });
  await prisma.discipline.upsert({
    where: { name: "Базы данных" },
    update: {},
    create: { name: "Базы данных", code: "DB" },
  });

  // 2. Преподаватели — идемпотентно по userId.
  const ivanova = await prisma.teacher.upsert({
    where: { userId: "2001" },
    update: { fio: "Иванова Ольга Петровна" },
    create: { userId: "2001", fio: "Иванова Ольга Петровна" },
  });
  const smirnov = await prisma.teacher.upsert({
    where: { userId: "2002" },
    update: { fio: "Смирнов Артём Валерьевич" },
    create: { userId: "2002", fio: "Смирнов Артём Валерьевич" },
  });

  // 3. Открытая сессия: дисциплина 1, преподаватель 2001.
  const startsAt = addDays(NOW, 7);
  const registrationDeadline = addDays(NOW, 5);
  const existingSlot = await prisma.examSlot.findFirst({
    where: {
      disciplineId: math.id,
      teacherId: ivanova.id,
      room: "А-204",
      status: "open",
    },
  });
  const slot =
    existingSlot ??
    (await prisma.examSlot.create({
      data: {
        disciplineId: math.id,
        teacherId: ivanova.id,
        startsAt,
        room: "А-204",
        expectedCapacity: 30,
        alertThreshold: 30,
        registrationDeadline,
        status: "open",
      },
    }));

  // 4. Тестовый платёж: запись на сессию (studentUserId — строка "1002").
  await prisma.booking.upsert({
    where: {
      paymentToken_slotId: {
        paymentToken: "pay_seed_0001",
        slotId: slot.id,
      },
    },
    update: {
      studentUserId: "1002",
      studentFio: "Сидоров Пётр Петрович",
      studentGroup: "ГР-13",
      amount: 500,
      status: "submitted",
    },
    create: {
      slotId: slot.id,
      disciplineId: math.id,
      teacherId: ivanova.id,
      studentUserId: "1002",
      studentFio: "Сидоров Пётр Петрович",
      studentGroup: "ГР-13",
      amount: 500,
      paymentToken: "pay_seed_0001",
      status: "submitted",
    },
  });

  // 5. StaffRole: 2001→teacher, 2002→teacher, 3001→directorate.
  // Для 1001 строки не создаётся — роль студента определяется по отсутствию строки.
  await prisma.staffRole.upsert({
    where: { userId: "2001" },
    update: { role: "teacher", teacherId: ivanova.id },
    create: { userId: "2001", role: "teacher", teacherId: ivanova.id },
  });
  await prisma.staffRole.upsert({
    where: { userId: "2002" },
    update: { role: "teacher", teacherId: smirnov.id },
    create: { userId: "2002", role: "teacher", teacherId: smirnov.id },
  });
  await prisma.staffRole.upsert({
    where: { userId: "3001" },
    update: { role: "directorate" },
    create: { userId: "3001", role: "directorate" },
  });

  console.log(`DEEP_LINK=rt_${math.id}_${slot.id}`);
  console.log(`SEED_PAYMENT_TOKEN=pay_seed_0001`);
}

await main();
await prisma.$disconnect();