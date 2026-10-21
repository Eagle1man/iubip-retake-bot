import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, resetDb, type Harness } from "../helpers/harness.js";
import { seedBase, seedRoles, type SeedBase } from "../helpers/data.js";
import { RoleService, bookingNumber, findByNumber } from "../../src/domain/staff/role.service.js";
import { SlotService } from "../../src/domain/slot/slot.service.js";
import { BookingService, hoursUntil } from "../../src/domain/booking/booking.service.js";
import { isSelectableSlot } from "../../src/domain/booking/booking.rules.js";

/**
 * Добивка покрытия домена (§11.5: ≥80% функций) по сценариям, которые
 * не проходят через HTTP: закрытие сессии, список записавшихся, поиск по номеру,
 * а также требование §13.13 «ошибка уведомления не должна ронять запись».
 */

let h: Harness;
let base: SeedBase;
let bookingSeq: number;
let bookingId: string;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  base = await seedBase(h.prisma);
  await seedRoles(h.prisma);

  const booking = await h.prisma.booking.create({
    data: {
      slotId: base.slotId,
      disciplineId: base.disciplineId,
      teacherId: base.teacherId,
      studentUserId: "1301",
      studentFio: "Списочников Артём Павлович",
      studentGroup: "ГР-92",
    },
  });
  bookingSeq = booking.seq;
  bookingId = booking.id;
});

afterAll(async () => {
  await h.close();
});

describe("RoleService (§14: студент — отсутствие роли)", () => {
  it("resolve: директория по chat id, преподаватель по StaffRole, остальные — студенты", async () => {
    const roles = new RoleService(h.prisma, h.config.DIRECTORATE_CHAT_ID);

    expect(await roles.resolve(h.config.DIRECTORATE_CHAT_ID)).toBe("directorate");
    expect(await roles.resolve("2001")).toBe("teacher");
    expect(await roles.resolve("9999")).toBe("student");
  });

  it("findTeacherByUserId: есть строка — вернулась, нет — null", async () => {
    const roles = new RoleService(h.prisma, h.config.DIRECTORATE_CHAT_ID);

    expect(await roles.findTeacherByUserId("2001")).toMatchObject({ fio: "Иванова Ольга Петровна" });
    expect(await roles.findTeacherByUserId("9999")).toBeNull();
  });
});

describe("номера записей (§9 экспорт, §13 оплата по номеру)", () => {
  it("bookingNumber: B-<seq>", () => {
    expect(bookingNumber(bookingSeq)).toBe(`B-${bookingSeq}`);
  });

  it("findByNumber: по B-<seq> находится, по мусору — null", async () => {
    const found = await findByNumber(h.prisma, bookingNumber(bookingSeq));
    expect(found?.id).toBe(bookingId);

    const cyrillic = await findByNumber(h.prisma, `Б-${bookingSeq}`);
    expect(cyrillic?.id).toBe(bookingId);

    expect(await findByNumber(h.prisma, "не номер")).toBeNull();
  });
});

describe("SlotService: закрытие и список записавшихся", () => {
  it("close переводит сессию в closed и убирает из открытых, уведомлений нет", async () => {
    const closingSlot = await h.prisma.examSlot.create({
      data: {
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        startsAt: new Date(Date.now() + 11 * 86_400_000),
        room: "З-1",
        registrationDeadline: new Date(Date.now() + 9 * 86_400_000),
        status: "open",
      },
    });
    const before = h.client.sent.length;

    const slots = new SlotService(h.prisma, h.sink);
    expect(await slots.close(closingSlot.id)).toEqual({ closed: true });

    const row = await h.prisma.examSlot.findUnique({ where: { id: closingSlot.id } });
    expect(row?.status).toBe("closed");
    expect(h.client.sent.length).toBe(before); // §13.10: закрытие без отмены — тихо

    const open = await slots.listOpen(base.disciplineId);
    expect(open.map((s) => s.slotId)).not.toContain(closingSlot.id);
  });

  it("listBooked: состав записавшихся для преподавателя (§10)", async () => {
    const slots = new SlotService(h.prisma, h.sink);
    const result = await slots.listBooked(base.slotId);

    expect(result.slotId).toBe(base.slotId);
    expect(result.total).toBe(1);
    expect(result.students[0]).toMatchObject({
      bookingId,
      studentFio: "Списочников Артём Павлович",
      studentGroup: "ГР-92",
      paymentStatus: "submitted",
      hasReceipt: false,
    });
  });
});

describe("правила выбора и времени", () => {
  const slot = {
    status: "open",
    registrationDeadline: new Date("2026-10-30T10:00:00Z"),
    startsAt: new Date("2026-10-31T10:00:00Z"),
  };

  it("isSelectableSlot дублирует условие открытия регистрации", () => {
    expect(isSelectableSlot(slot, new Date("2026-10-21T00:00:00Z"))).toBe(true);
    expect(isSelectableSlot(slot, new Date("2026-10-30T10:00:01Z"))).toBe(false);
    expect(isSelectableSlot({ ...slot, status: "closed" }, new Date("2026-10-21T00:00:00Z"))).toBe(false);
  });

  it("hoursUntil округляет до часов", () => {
    const now = new Date("2026-10-21T00:00:00Z");
    expect(hoursUntil(new Date("2026-10-22T06:00:00Z"), now)).toBe(30);
    expect(hoursUntil(now, now)).toBe(0);
  });
});

describe("§13.13: сбой уведомления не должен ронять запись", () => {
  it("create возвращает запись, даже если sink кидает", async () => {
    const brokenSink = {
      notify: async () => {
        throw new Error("sink down");
      },
    };
    const bookings = new BookingService(h.prisma, brokenSink, 0, h.config.DIRECTORATE_CHAT_ID);

    const result = await bookings.create({
      slotId: base.slotId,
      studentUserId: "1302",
      studentFio: "Ломов Уведомленный Игоревич",
      studentGroup: "ГР-93",
    });

    expect(result.status).toBe("submitted");
    const row = await h.prisma.booking.findUnique({ where: { id: result.bookingId } });
    expect(row?.studentUserId).toBe("1302");
  });
});
