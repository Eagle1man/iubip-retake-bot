/**
 * Сид демо-данных должен быть идемпотентным.
 *
 * Сценарий из гейта 22.10.2026: демо-шаг «сменить аудиторию» меняет room сессии,
 * а «отменить сессию» переводит слот в cancelled. После этого повторный сид
 * искал слот по room="А-204", не находил, создавал второй — а запись уходила
 * в create и падала с P2002 по частичному индексу.
 *
 * Здесь этот сценарий воспроизводится явно: сначала сид, потом «порча» стенда
 * (аудитория + отмена + оплаченная запись), потом сид снова.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { resetDb } from "../helpers/harness.js";
import { TEST_DATABASE_URL } from "../setup/global.js";

let prisma: PrismaClient;

const runSeed = (): void => {
  execSync("npx tsx prisma/seed.ts", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
};

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  await resetDb(prisma);
});

afterAll(async () => {
  await resetDb(prisma);
  await prisma.$disconnect();
});

describe("prisma/seed.ts идемпотентен", () => {
  it("повторный запуск после «порчи» стенда не падает и не плодит слоты", async () => {
    // Первый сид: чистое состояние.
    runSeed();

    const first = await prisma.examSlot.findMany();
    expect(first).toHaveLength(1);
    const firstSlot = first[0];
    if (!firstSlot) throw new Error("сид не создал слот");
    expect(firstSlot.room).toBe("А-204");
    expect(firstSlot.status).toBe("open");

    // Порча стенда как после демо: аудитория изменена, слот отменён, запись оплачена.
    await prisma.examSlot.update({
      where: { id: firstSlot.id },
      data: { room: "Ауд-777", status: "cancelled" },
    });
    await prisma.booking.updateMany({ data: { status: "paid" } });

    // Повторный сид обязан пройти (раньше падал с P2002) и вернуть исходное состояние.
    runSeed();

    const after = await prisma.examSlot.findMany();
    expect(after).toHaveLength(1);
    const afterSlot = after[0];
    if (!afterSlot) throw new Error("после сида слот пропал");
    expect(afterSlot.room).toBe("А-204");
    expect(afterSlot.status).toBe("open");

    const bookings = await prisma.booking.findMany();
    expect(bookings).toHaveLength(1);
    expect(bookings[0]?.status).toBe("submitted");
    expect(bookings[0]?.studentFio).toBe("Сидоров Пётр Петрович");

    // И третий раз — тоже без падений.
    runSeed();
    expect(await prisma.examSlot.count()).toBe(1);
    expect(await prisma.booking.count()).toBe(1);
  });
});
