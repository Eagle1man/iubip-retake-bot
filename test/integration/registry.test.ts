import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, resetDb, type Harness } from "../helpers/harness.js";
import { seedBase, seedRoles, type SeedBase } from "../helpers/data.js";

let h: Harness;
let base: SeedBase;
let bookingId: string;

const FIO = "Реестров Никита Павлович";
const CSV_HEADER = "fio,amount,paid_at,purpose";

const importCsv = (csv: string) =>
  h.app.inject({
    method: "POST",
    url: "/internal/registry/import",
    headers: { ...h.headers, "content-type": "text/csv" },
    payload: csv,
  });

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  base = await seedBase(h.prisma);
  await seedRoles(h.prisma);

  bookingId = (
    await h.prisma.booking.create({
      data: {
        slotId: base.slotId,
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        studentUserId: "1201",
        studentFio: FIO,
        studentGroup: "ГР-81",
        amount: 500,
        status: "submitted",
      },
    })
  ).id;
});

afterAll(async () => {
  await h.close();
});

describe("POST /internal/registry/import (§9)", () => {
  it("совпавшая строка переводит запись в paid, несовпавшая возвращается списком", async () => {
    const csv = [CSV_HEADER, `${FIO},500,2026-10-20,оплата пересдачи`, "Неизвестный Студент,700,2026-10-20,оплата"].join(
      "\n",
    );

    const res = await importCsv(csv);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rowsTotal: 2,
      rowsMatched: 1,
      rowsUnmatched: ["Неизвестный Студент"],
    });

    const booking = await h.prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking?.status).toBe("paid");

    const notice = h.client.sent.find((m) => m.text.includes("Оплата подтверждена по реестру"));
    expect(notice?.userId).toBe("1201");
  });

  it("повторный импорт тех же денег — это совпадение, а не ошибка", async () => {
    const csv = [CSV_HEADER, `${FIO},500,2026-10-20,оплата пересдачи`].join("\n");
    const res = await importCsv(csv);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rowsTotal: 1, rowsMatched: 1, rowsUnmatched: [] });
    expect((await h.prisma.booking.findUnique({ where: { id: bookingId } }))?.status).toBe("paid");
  });

  it("импорт записан в историю (RegistryImport/RegistryRow)", async () => {
    const imports = await h.prisma.registryImport.count();
    const rows = await h.prisma.registryRow.findMany({ where: { payerFioNorm: FIO.toLowerCase() } });

    expect(imports).toBe(2);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.importId !== "")).toBe(true);
  });

  it("пустое тело → 400", async () => {
    const res = await importCsv("");
    expect(res.statusCode).toBe(400);
  });

  it("нет обязательных колонок → 400, а не 500", async () => {
    const res = await importCsv("name,sum\nИванов,500");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "registry_invalid" });
  });

  it("без токена → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/registry/import",
      headers: { "content-type": "text/csv" },
      payload: CSV_HEADER,
    });
    expect(res.statusCode).toBe(401);
  });
});
