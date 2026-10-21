import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, resetDb, type Harness } from "../helpers/harness.js";
import { seedBase, seedClosedSlot, seedRoles, type SeedBase } from "../helpers/data.js";

let h: Harness;
let strict: Harness; // CANCEL_DEADLINE_HOURS=24 — для проверки запрета отмены
let base: SeedBase;
let secondSlotId: string;
let capacityZeroSlotId: string;
let soonSlotId: string;

beforeAll(async () => {
  h = await createHarness();
  strict = await createHarness({ CANCEL_DEADLINE_HOURS: 24 });
  await resetDb(h.prisma);

  base = await seedBase(h.prisma);
  await seedRoles(h.prisma);

  secondSlotId = (
    await h.prisma.examSlot.create({
      data: {
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        startsAt: new Date(Date.now() + 8 * 86_400_000),
        room: "В-305",
        expectedCapacity: 30,
        registrationDeadline: new Date(Date.now() + 6 * 86_400_000),
        status: "open",
      },
    })
  ).id;

  capacityZeroSlotId = (
    await h.prisma.examSlot.create({
      data: {
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        startsAt: new Date(Date.now() + 9 * 86_400_000),
        room: "Г-101",
        expectedCapacity: 0,
        alertThreshold: 0,
        registrationDeadline: new Date(Date.now() + 7 * 86_400_000),
        status: "open",
      },
    })
  ).id;

  soonSlotId = (
    await h.prisma.examSlot.create({
      data: {
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        startsAt: new Date(Date.now() + 12 * 3_600_000),
        room: "Д-102",
        registrationDeadline: new Date(Date.now() + 6 * 3_600_000),
        status: "open",
      },
    })
  ).id;
});

afterAll(async () => {
  await strict.close();
  await h.close();
});

const createBooking = (payload: Record<string, unknown>, over?: Harness) =>
  (over ?? h).app.inject({
    method: "POST",
    url: "/internal/bookings",
    headers: (over ?? h).headers,
    payload,
  });

describe("POST /internal/bookings (§13.2 дедуп, §13.6 очередь, §13.7 дедлайн)", () => {
  it("первая запись → 201 submitted", async () => {
    const res = await createBooking({
      slotId: base.slotId,
      studentUserId: "1011",
      studentFio: "Смирнов Артём Игоревич",
      studentGroup: "ГР-21",
      paymentToken: "pay_t_1011",
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "submitted", deduplicated: false });

    const rows = await h.prisma.booking.findMany({ where: { studentUserId: "1011" } });
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.seq).toBeGreaterThan(0); // номер записи B-<seq>
  });

  it("тот же paymentToken повторно → 200 deduplicated, строки не плодятся", async () => {
    const res = await createBooking({
      slotId: base.slotId,
      studentUserId: "1011",
      studentFio: "Смирнов Артём Игоревич",
      studentGroup: "ГР-21",
      paymentToken: "pay_t_1011",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deduplicated: true });
    expect(await h.prisma.booking.count({ where: { studentUserId: "1011" } })).toBe(1);
  });

  it("второй активной записи на дисциплину нет: 409 (разный регистр ФИО)", async () => {
    const res = await createBooking({
      slotId: secondSlotId,
      studentUserId: "1012",
      studentFio: "смирнов артём игоревич",
      studentGroup: "ГР-21",
      paymentToken: "pay_t_1012",
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "duplicate_active" });
    expect(await h.prisma.booking.count({ where: { studentUserId: "1012" } })).toBe(0);
  });

  it("неизвестная сессия → 404", async () => {
    const res = await createBooking({
      slotId: "no-such-slot",
      studentUserId: "1013",
      studentFio: "Кузнецов Павел Олегович",
      studentGroup: "ГР-22",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "slot_not_found" });
  });

  it("дедлайн регистрации прошёл → 410", async () => {
    const closed = await seedClosedSlot(h.prisma, base);
    const res = await createBooking({
      slotId: closed,
      studentUserId: "1014",
      studentFio: "Орлов Максим Романович",
      studentGroup: "ГР-23",
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: "registration_closed" });
  });

  it("expectedCapacity не блокирует запись (§13.13)", async () => {
    const res = await createBooking({
      slotId: capacityZeroSlotId,
      studentUserId: "1015",
      studentFio: "Лебедев Илья Тарасович",
      studentGroup: "ГР-24",
    });
    expect(res.statusCode).toBe(201);
  });

  it("порог превышен — дирекция получает уведомление (§13.13)", async () => {
    const toDirectorate = h.client.sent.filter((m) => m.userId === "3001");
    expect(toDirectorate.some((m) => m.text.includes("записалось"))).toBe(true);
  });

  it("параллельные записи разных студентов не теряются (§13.6)", async () => {
    const fios = ["Яковлев Данил Кириллович", "Попова Алина Витальевна", "Громов Егор Львович"];
    const results = await Promise.all(
      fios.map((fio, i) =>
        createBooking({
          slotId: base.slotId,
          studentUserId: `10${20 + i}`,
          studentFio: fio,
          studentGroup: "ГР-30",
        }),
      ),
    );

    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    const created = await h.prisma.booking.findMany({
      where: { studentFio: { in: fios } },
    });
    expect(created).toHaveLength(3);
    expect(new Set(created.map((b) => b.seq)).size).toBe(3);
  });
});

describe("чеки (§13.5)", () => {
  const fileBase64 = Buffer.from("demo-receipt-pdf-bytes").toString("base64");
  let bookingA: string;
  let bookingB: string;

  const upload = (id: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: "POST",
      url: `/internal/bookings/${id}/receipt`,
      headers: h.headers,
      payload,
    });

  beforeAll(async () => {
    bookingA = (
      await h.prisma.booking.create({
        data: {
          slotId: base.slotId,
          disciplineId: base.disciplineId,
          teacherId: base.teacherId,
          studentUserId: "1031",
          studentFio: "Чеков Артур Маркович",
          studentGroup: "ГР-41",
        },
      })
    ).id;
    bookingB = (
      await h.prisma.booking.create({
        data: {
          slotId: base.slotId,
          disciplineId: base.disciplineId,
          teacherId: base.teacherId,
          studentUserId: "1032",
          studentFio: "Чекова Вера Марковна",
          studentGroup: "ГР-41",
        },
      })
    ).id;
  });

  it("приложить чек → 200", async () => {
    const res = await upload(bookingA, { fileBase64, fileName: "receipt.pdf" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deduplicated: false });

    const row = await h.prisma.booking.findUnique({ where: { id: bookingA } });
    expect(row?.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.receiptPath).toBeTruthy();
  });

  it("тот же чек повторно → 200 deduplicated", async () => {
    const res = await upload(bookingA, { fileBase64 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deduplicated: true });
  });

  it("тот же чек в другую запись того же слота → 409", async () => {
    const res = await upload(bookingB, { fileBase64 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "receipt_used_elsewhere" });
  });

  it("неизвестная запись → 404", async () => {
    const res = await upload("no-such-booking", { fileBase64 });
    expect(res.statusCode).toBe(404);
  });

  it("пустое тело → 400", async () => {
    const res = await upload(bookingA, {});
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /internal/bookings/:id/cancel", () => {
  it("неизвестная запись → 404", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/bookings/no-such/cancel",
      headers: h.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("отмена → 200, повторная отмена идемпотентна", async () => {
    const booking = await h.prisma.booking.create({
      data: {
        slotId: base.slotId,
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        studentUserId: "1041",
        studentFio: "Отменов Студент Петрович",
        studentGroup: "ГР-51",
      },
    });

    const first = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${booking.id}/cancel`,
      headers: h.headers,
    });
    expect(first.statusCode).toBe(200);

    const second = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${booking.id}/cancel`,
      headers: h.headers,
    });
    expect(second.statusCode).toBe(200);

    const row = await h.prisma.booking.findUnique({ where: { id: booking.id } });
    expect(row?.status).toBe("cancelled");
  });

  it("CANCEL_DEADLINE_HOURS=24: за 12 часов до начала отмена → 409", async () => {
    const res = await strict.app.inject({
      method: "POST",
      url: "/internal/bookings",
      headers: strict.headers,
      payload: {
        slotId: soonSlotId,
        studentUserId: "1042",
        studentFio: "Поздний Отмена Сергей",
        studentGroup: "ГР-52",
      },
    });
    expect(res.statusCode).toBe(201);
    const bookingId = res.json().bookingId as string;

    const cancel = await strict.app.inject({
      method: "POST",
      url: `/internal/bookings/${bookingId}/cancel`,
      headers: strict.headers,
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json()).toMatchObject({ code: "cancel_forbidden" });
  });
});

describe("оплата и явка (§10: только дирекция/преподаватель)", () => {
  let bookingId: string;
  let paymentToken: string;

  beforeAll(async () => {
    const created = await createBooking({
      slotId: base.slotId,
      studentUserId: "1051",
      studentFio: "Оплатов Артём Юрьевич",
      studentGroup: "ГР-61",
      paymentToken: "pay_oplata_1",
    });
    bookingId = created.json().bookingId;
    paymentToken = "pay_oplata_1";
  });

  it("без X-User-Id → 403", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${bookingId}/payment`,
      headers: h.headers,
      payload: { paid: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("студент не отмечает оплату → 403", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${bookingId}/payment`,
      headers: { ...h.headers, "X-User-Id": "1051" },
      payload: { paid: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("дирекция отмечает оплату → 200, статус paid", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${bookingId}/payment`,
      headers: { ...h.headers, "X-User-Id": "3001" },
      payload: { paid: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "paid" });
  });

  it("GET /internal/payments/:token видит подтверждённый платёж", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/internal/payments/${paymentToken}`,
      headers: h.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claimed: true, status: "paid" });
  });

  it("неизвестный токен платежа → 404", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/internal/payments/pay_unknown",
      headers: h.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("ярку без роли → 403", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${bookingId}/attendance`,
      headers: h.headers,
      payload: { attendance: "attended" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("преподаватель отмечает явку → 200", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${bookingId}/attendance`,
      headers: { ...h.headers, "X-User-Id": "2001" },
      payload: { attendance: "attended" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attendance: "attended" });
  });

  it("невалидное значение явки → 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${bookingId}/attendance`,
      headers: { ...h.headers, "X-User-Id": "2001" },
      payload: { attendance: "maybe" },
    });
    expect(res.statusCode).toBe(400);
  });
});
