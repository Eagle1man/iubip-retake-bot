import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, resetDb, type Harness } from "../helpers/harness.js";
import { seedBase, seedRoles, type SeedBase } from "../helpers/data.js";

let h: Harness;
let base: SeedBase;
let cancelledSlotId: string;

const STUDENTS = [
  { userId: "1101", fio: "Списков Никита Андреевич", group: "ГР-71", status: "submitted" as const },
  { userId: "1102", fio: "Спискова Дарья Андреевна", group: "ГР-71", status: "paid" as const },
] as const;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  base = await seedBase(h.prisma);
  await seedRoles(h.prisma);

  for (const student of STUDENTS) {
    await h.prisma.booking.create({
      data: {
        slotId: base.slotId,
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        studentUserId: student.userId,
        studentFio: student.fio,
        studentGroup: student.group,
        status: student.status,
      },
    });
  }

  cancelledSlotId = (
    await h.prisma.examSlot.create({
      data: {
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        startsAt: new Date(Date.now() + 10 * 86_400_000),
        room: "Е-1",
        registrationDeadline: new Date(Date.now() + 8 * 86_400_000),
        status: "open",
      },
    })
  ).id;
});

afterAll(async () => {
  await h.close();
});

describe("GET /internal/slots (§7)", () => {
  it("открытые сессии со счётчиком записавшихся", async () => {
    const res = await h.app.inject({ method: "GET", url: "/internal/slots", headers: h.headers });
    expect(res.statusCode).toBe(200);

    const slots = res.json() as { slotId: string; bookedCount: number; room: string }[];
    const ours = slots.find((s) => s.slotId === base.slotId);
    expect(ours).toBeDefined();
    expect(ours?.bookedCount).toBe(2);
    expect(ours?.room).toBe("А-204");
  });

  it("фильтр по дисциплине", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/internal/slots?disciplineId=${base.disciplineId}`,
      headers: h.headers,
    });
    const slots = res.json() as { disciplineId: string }[];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.disciplineId === base.disciplineId)).toBe(true);
  });

  it("без токена → 401", async () => {
    const res = await h.app.inject({ method: "GET", url: "/internal/slots" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /internal/slots/:id/room (§13.9 уведомление записанным)", () => {
  it("смена аудитории → 200, уведомлены все записавшиеся", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/slots/${base.slotId}/room`,
      headers: h.headers,
      payload: { room: "Ауд-777" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updated: true, notified: 2 });

    const slot = await h.prisma.examSlot.findUnique({ where: { id: base.slotId } });
    expect(slot?.room).toBe("Ауд-777");

    const roomChanges = h.client.sent.filter((m) => m.text.includes("Аудитория изменена"));
    expect(new Set(roomChanges.map((m) => m.userId))).toEqual(new Set(STUDENTS.map((s) => s.userId)));
  });

  it("повторная смена на ту же аудиторию — уведомлений нет", async () => {
    const before = h.client.sent.filter((m) => m.text.includes("Аудитория изменена")).length;

    const res = await h.app.inject({
      method: "POST",
      url: `/internal/slots/${base.slotId}/room`,
      headers: h.headers,
      payload: { room: "Ауд-777" },
    });
    expect(res.statusCode).toBe(200);

    const after = h.client.sent.filter((m) => m.text.includes("Аудитория изменена")).length;
    expect(after).toBe(before);
  });

  it("неизвестная сессия → 404", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/slots/no-such/room",
      headers: h.headers,
      payload: { room: "X-1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("пустая аудитория → 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/slots/${base.slotId}/room`,
      headers: h.headers,
      payload: { room: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /internal/slots/:id/cancel (§13.10 отмена сессии)", () => {
  it("отмена → 200, записи сохраняются, всем записанным уведомление", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/slots/${cancelledSlotId}/cancel`,
      headers: h.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cancelled: true, notified: 0 });

    const slot = await h.prisma.examSlot.findUnique({ where: { id: cancelledSlotId } });
    expect(slot?.status).toBe("cancelled");
    expect(await h.prisma.booking.count({ where: { slotId: cancelledSlotId } })).toBe(0);
  });

  it("повторная отмена → 409", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/slots/${cancelledSlotId}/cancel`,
      headers: h.headers,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "slot_cancelled" });
  });

  it("неизвестная сессия → 404", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/slots/no-such/cancel",
      headers: h.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("отменённая сессия исчезает из списка открытых", async () => {
    const res = await h.app.inject({ method: "GET", url: "/internal/slots", headers: h.headers });
    const ids = (res.json() as { slotId: string }[]).map((s) => s.slotId);
    expect(ids).not.toContain(cancelledSlotId);
  });

  it("уведомление об отмене дошло записавшимся", async () => {
    await h.app.inject({
      method: "POST",
      url: `/internal/slots/${base.slotId}/cancel`,
      headers: h.headers,
    });

    const notices = h.client.sent.filter((m) => m.text.includes("Сессия отменена"));
    expect(new Set(notices.map((m) => m.userId))).toEqual(new Set(STUDENTS.map((s) => s.userId)));

    // §13.10: записи остаются в истории, а не удаляются.
    expect(await h.prisma.booking.count({ where: { slotId: base.slotId } })).toBe(2);
  });
});

describe("GET /internal/export/bookings.csv (§9)", () => {
  it("возвращается CSV с заявленными полями", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/internal/export/bookings.csv",
      headers: h.headers,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("bookings.csv");

    const [header, ...lines] = res.body.split("\n");
    expect(header).toBe(
      "booking_id,student_fio,student_group,discipline,teacher_fio,starts_at,time,room,amount,payment_status,attendance,created_at",
    );
    expect(header?.split(",")).toHaveLength(12);
    expect(res.body).toContain(STUDENTS[0].fio);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^B-\d+,/);
  });

  it("без токена → 401", async () => {
    const res = await h.app.inject({ method: "GET", url: "/internal/export/bookings.csv" });
    expect(res.statusCode).toBe(401);
  });
});
