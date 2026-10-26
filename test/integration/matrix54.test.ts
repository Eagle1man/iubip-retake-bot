import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queue, Worker } from "bullmq";
import { createHarness, findCallback, lastBotMessage, resetDb, type Harness } from "../helpers/harness.js";
import { seedBase, seedRoles, type SeedBase } from "../helpers/data.js";
import { BookingService } from "../../src/domain/booking/booking.service.js";
import { bookingNumber } from "../../src/domain/staff/role.service.js";
import {
  isReminderWithinWindow,
  reminderTriggerAt,
} from "../../src/domain/reminder/reminder.rules.js";
import { createNotifyQueue, getRedis, QueueReminderScheduler } from "../../src/infra/queue/queue.js";
import { createNotifyWorker } from "../../src/infra/queue/worker.js";
import type { MaxClient } from "../../src/infra/max/types.js";
import { texts } from "../../src/bot/texts.js";

/**
 * Матрица проверки по ролям из расширенного ТЗ, раздел 5.4 — чек-лист CI.
 *
 * Строки 1–2, 4–7 проверяют ПРАВИЛА (видимость, идемпотентность, оплату,
 * места, явку), строка 3 — реакцию бота, строка 8 — напоминания (±5 мин).
 *
 * Строка 1 написана по правилу, принятому заказчиком 26.10.2026: слот виден
 * студенту ДО подтверждения оплаты — оплата не блокирует запись (MVP),
 * сценарий «оплата → затем выбор слота» не применяется.
 *
 * Названия тестов содержат маркер «матрица №N» — scripts/ci.mjs проверяет,
 * что все 8 строк матрицы закрыты тестом.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let h: Harness;
let base: SeedBase;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  base = await seedBase(h.prisma);
  await seedRoles(h.prisma);
});

afterAll(async () => {
  await h?.close();
});

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: условие не наступило");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const inject = (userId: string, body: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url: "/mock/max/inject", payload: { userId, ...body } });

describe("матрица §5.4: проверка по ролям (без подключения MAX)", () => {
  let firstBookingId = "";

  it("матрица №1: открытая сессия видна студенту до подтверждения оплаты (правило MVP)", async () => {
    // Слот виден ДО какой-либо оплаты.
    const before = await h.ctx.slots.listOpen(base.disciplineId);
    expect(before.map((s) => s.slotId)).toContain(base.slotId);

    // Запись создаётся со статусом submitted — оплата ещё не подтверждена.
    const created = await h.app.inject({
      method: "POST",
      url: "/internal/bookings",
      headers: h.headers,
      payload: {
        slotId: base.slotId,
        studentUserId: "1001",
        studentFio: "Петров Пётр Петрович",
        studentGroup: "ГР-1",
        paymentToken: "pay_matrix1",
      },
    });
    expect(created.statusCode).toBe(201);
    firstBookingId = (created.json() as { bookingId: string }).bookingId;

    const booking = await h.prisma.booking.findUnique({ where: { id: firstBookingId } });
    expect(booking?.status).toBe("submitted");

    // Оплата не подтверждена — и слот не исчез: фильтра «только после оплаты» нет.
    const after = await h.ctx.slots.listOpen(base.disciplineId);
    expect(after.map((s) => s.slotId)).toContain(base.slotId);
  });

  it("матрица №2: payment_status=confirmed — слот виден, бронь ровно одна", async () => {
    const pay = await h.app.inject({
      method: "POST",
      url: `/internal/bookings/${firstBookingId}/payment`,
      headers: { ...h.headers, "x-user-id": "3001" },
      payload: { paid: true },
    });
    expect(pay.statusCode).toBe(200);

    const paid = await h.prisma.booking.findUnique({ where: { id: firstBookingId } });
    expect(paid?.status).toBe("paid");

    // Повтор того же paymentToken — идемпотентно, без второй строки.
    const repeat = await h.app.inject({
      method: "POST",
      url: "/internal/bookings",
      headers: h.headers,
      payload: {
        slotId: base.slotId,
        studentUserId: "1001",
        studentFio: "Петров Пётр Петрович",
        studentGroup: "ГР-1",
        paymentToken: "pay_matrix1",
      },
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({ deduplicated: true });

    const count = await h.prisma.booking.count({
      where: { slotId: base.slotId, studentUserId: "1001" },
    });
    expect(count).toBe(1);

    // Слот виден и после confirmed.
    const open = await h.ctx.slots.listOpen(base.disciplineId);
    expect(open.map((s) => s.slotId)).toContain(base.slotId);
  });

  it("матрица №3: повторная запись — без дубля, бот отвечает «уже есть активная запись»", async () => {
    const FIO = "Сидоров Сидор Сидорович";

    // Первый проход через бота: deep link → сессия → ФИО → группа → подтверждение.
    expect((await inject("1003", { text: `/start ${base.token}` })).statusCode).toBe(200);
    const slotButton = await findCallback(h.prisma, "1003", "s:");
    expect(slotButton).toBe(`s:${base.slotId}`);
    expect((await inject("1003", { callbackData: slotButton })).statusCode).toBe(200);
    await inject("1003", { text: FIO });
    await inject("1003", { text: "ГР-3" });
    const confirm = await findCallback(h.prisma, "1003", "yes");
    await inject("1003", { callbackData: confirm });

    const firstPass = await lastBotMessage(h.prisma, "1003");
    expect(firstPass?.text).toContain("Вы записаны");

    // Второй проход тем же студентом: дубля нет, ответ — текст duplicate.
    await inject("1003", { text: `/start ${base.token}` });
    const slotButton2 = await findCallback(h.prisma, "1003", "s:");
    await inject("1003", { callbackData: slotButton2 });
    await inject("1003", { text: FIO });
    await inject("1003", { text: "ГР-3" });
    const confirm2 = await findCallback(h.prisma, "1003", "yes");
    await inject("1003", { callbackData: confirm2 });

    const secondPass = await lastBotMessage(h.prisma, "1003");
    expect(secondPass?.text).toContain(texts.student.duplicate);

    const count = await h.prisma.booking.count({ where: { studentFio: FIO } });
    expect(count).toBe(1);
  });

  it("матрица №4: подтверждение оплаты менеджером → confirmed и уведомление студенту", async () => {
    const booking = await h.prisma.booking.findFirst({ where: { studentFio: "Сидоров Сидор Сидорович" } });
    expect(booking).not.toBeNull();

    // Через бота дирекции (менеджера): ввод номера → «Оплачено».
    const number = bookingNumber(booking?.seq ?? 0);

    expect((await inject("3001", { text: "Отметить оплату" })).statusCode).toBe(200);
    expect((await inject("3001", { text: number })).statusCode).toBe(200);
    const payButton = await findCallback(h.prisma, "3001", `pay:${booking?.id}:`);
    expect(payButton).toBe(`pay:${booking?.id}:paid`);
    await inject("3001", { callbackData: payButton });

    const paid = await h.prisma.booking.findUnique({ where: { id: booking?.id as string } });
    expect(paid?.status).toBe("paid");

    // Студенту пришло уведомление об оплате.
    const notice = await h.prisma.notificationLog.findFirst({
      where: { userId: "1003", kind: "payment_confirmed" },
    });
    expect(notice).not.toBeNull();
    expect(notice?.text).toContain("Оплата по записи подтверждена");
  });

  it("матрица №5: слот с max_seats=2 — после двух броней «Мест нет»", async () => {
    const startsAt = new Date(Date.now() + 10 * 86_400_000);
    const created = await h.app.inject({
      method: "POST",
      url: "/internal/slots",
      headers: h.headers,
      payload: {
        disciplineId: base.disciplineId,
        teacherId: base.teacherId,
        startsAt: startsAt.toISOString(),
        room: "В-2",
        expectedCapacity: 30,
        alertThreshold: 30,
        registrationDeadline: new Date(startsAt.getTime() - 86_400_000).toISOString(),
        maxSeats: 2,
      },
    });
    expect(created.statusCode).toBe(201);
    const slot5Id = (created.json() as { slotId: string; maxSeats: number }).slotId;
    expect((created.json() as { maxSeats: number }).maxSeats).toBe(2);

    // Две брони проходят.
    for (const [i, fio] of ["Алферов Алфей Алфеевич", "Борисов Борис Борисович"].entries()) {
      const res = await h.app.inject({
        method: "POST",
        url: "/internal/bookings",
        headers: h.headers,
        payload: {
          slotId: slot5Id,
          studentUserId: `1005-${i}`,
          studentFio: fio,
          studentGroup: `ГР-5${i}`,
          paymentToken: `pay_matrix5_${i}`,
        },
      });
      expect(res.statusCode).toBe(201);
    }

    // Третья — 409 no_seats.
    const third = await h.app.inject({
      method: "POST",
      url: "/internal/bookings",
      headers: h.headers,
      payload: {
        slotId: slot5Id,
        studentUserId: "1005-2",
        studentFio: "Валентов Валент Валентович",
        studentGroup: "ГР-52",
        paymentToken: "pay_matrix5_2",
      },
    });
    expect(third.statusCode).toBe(409);
    expect(third.json()).toMatchObject({ code: "no_seats" });

    // API-список: bookedCount=2, maxSeats=2.
    const list = await h.app.inject({
      method: "GET",
      url: `/internal/slots?disciplineId=${base.disciplineId}`,
      headers: h.headers,
    });
    const slot5 = (list.json() as { slotId: string; bookedCount: number; maxSeats: number }[]).find(
      (s) => s.slotId === slot5Id,
    );
    expect(slot5).toMatchObject({ bookedCount: 2, maxSeats: 2 });

    // В боте: список помечен «Мест нет», попытка записи отвечает текстом noSeats.
    const token = `rt_${base.disciplineId}_${slot5Id}`;
    await inject("1005", { text: `/start ${token}` });
    const listMessage = await lastBotMessage(h.prisma, "1005");

    // В списке несколько сессий дисциплины — ищем кнопку ИМЕННО слота с лимитом.
    const slot5Button = listMessage?.keyboard?.buttons
      .flat()
      .find((button) => button.callbackData === `s:${slot5Id}`);
    expect(slot5Button).toBeDefined();
    expect(slot5Button?.text.startsWith(texts.student.slotFull)).toBe(true);

    await inject("1005", { callbackData: `s:${slot5Id}` });
    await inject("1005", { text: "Валентов Валент Валентович" });
    await inject("1005", { text: "ГР-52" });
    const confirm = await findCallback(h.prisma, "1005", "yes");
    await inject("1005", { callbackData: confirm });

    const rejected = await lastBotMessage(h.prisma, "1005");
    expect(rejected?.text).toContain(texts.student.noSeats);
  });

  it("матрица №6: отметка «Пришёл» → attended и уведомление менеджеру", async () => {
    const booking = await h.prisma.booking.findFirst({ where: { studentFio: "Сидоров Сидор Сидорович" } });
    expect(booking).not.toBeNull();

    const result = await h.ctx.bookings.setAttendance(booking?.id as string, "attended");
    expect(result.attendance).toBe("attended");

    const notice = await h.prisma.notificationLog.findFirst({
      where: { userId: h.config.DIRECTORATE_CHAT_ID, kind: "attendance_marked" },
    });
    expect(notice).not.toBeNull();
    expect(notice?.text).toContain("Сидоров");
    expect(notice?.text).toContain("пришёл");

    // Повтор той же отметки идемпотентен: уведомление не дублируется.
    await h.ctx.bookings.setAttendance(booking?.id as string, "attended");
    const notices = await h.prisma.notificationLog.count({
      where: { userId: h.config.DIRECTORATE_CHAT_ID, kind: "attendance_marked" },
    });
    expect(notices).toBe(1);
  });

  it("матрица №7: отметка «Не пришёл» → attendance_status=no_show", async () => {
    const booking = await h.prisma.booking.findFirst({
      where: { studentFio: "Алферов Алфей Алфеевич" },
    });
    expect(booking).not.toBeNull();

    await h.ctx.bookings.setAttendance(booking?.id as string, "no_show");

    const updated = await h.prisma.booking.findUnique({ where: { id: booking?.id as string } });
    expect(updated?.attendance).toBe("no_show");
  });

  it("матрица №8: домен запрашивает планирование напоминания при создании записи", async () => {
    const scheduled: { id: string; startsAt: Date }[] = [];
    const recorder = {
      schedule: async (slot: { id: string; startsAt: Date }) => {
        scheduled.push(slot);
      },
    };
    const bookings = new BookingService(
      h.prisma,
      h.sink,
      h.config.CANCEL_DEADLINE_HOURS,
      h.config.DIRECTORATE_CHAT_ID,
      recorder,
    );

    await bookings.create({
      slotId: base.slotId,
      studentUserId: "1008",
      studentFio: "Напоминаев Напомин Напоминович",
      studentGroup: "ГР-8",
      paymentToken: "pay_matrix8",
    });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.id).toBe(base.slotId);

    // Выключенные напоминания не планируются вовсе.
    const off = new BookingService(h.prisma, h.sink, 0, h.config.DIRECTORATE_CHAT_ID);
    await off.create({
      slotId: base.slotId,
      studentUserId: "1008b",
      studentFio: "Напоминаев Второй Напомин",
      studentGroup: "ГР-8",
      paymentToken: "pay_matrix8b",
    });
    expect(scheduled).toHaveLength(1); // новых планирований не было
  });

  it("матрица №8: задержка очереди в окне ±5 мин и фактическая доставка напоминания", async () => {
    const queue: Queue = createNotifyQueue(REDIS_URL);
    await queue.obliterate({ force: true }).catch(() => undefined);

    try {
      const scheduler = new QueueReminderScheduler(queue, true);

      // (а) Слот через 25 ч → триггер через 1 ч: заявленная задержка в окне ±5 мин.
      const startsAt = new Date(Date.now() + 25 * 3_600_000);
      const slotId = `remind-check-${Date.now()}`;
      await scheduler.schedule({ id: slotId, startsAt });

      const job = await queue.getJob(`remind-${slotId}`);
      expect(job).toBeDefined();
      const expectedDelay = reminderTriggerAt(startsAt).getTime() - Date.now();
      expect(isReminderWithinWindow(job?.opts.delay ?? -1, expectedDelay, 5)).toBe(true);

      // Выключатель: enabled=false → ничего не планируется.
      const offScheduler = new QueueReminderScheduler(queue, false);
      await offScheduler.schedule({ id: "remind-disabled-check", startsAt });
      expect(await queue.getJob("remind-remind-disabled-check")).toBeUndefined();

      // (б) Триггер уже в прошлом (до сессии < 24 ч) → задержка 0, доставка живая.
      const remindSlot = await h.prisma.examSlot.create({
        data: {
          disciplineId: base.disciplineId,
          teacherId: base.teacherId,
          startsAt: new Date(Date.now() + 2 * 3_600_000),
          room: "Н-9",
          registrationDeadline: new Date(Date.now() + 3_600_000),
          status: "open",
        },
      });
      await h.prisma.booking.create({
        data: {
          slotId: remindSlot.id,
          disciplineId: base.disciplineId,
          teacherId: base.teacherId,
          studentUserId: "1008-live",
          studentFio: "Ждущий Ждун Ждунович",
          studentGroup: "ГР-88",
          paymentToken: "pay_matrix8_live",
        },
      });

      const sent: { userId: string; text: string }[] = [];
      const fakeClient: MaxClient = {
        sendMessage: async (userId: string, text: string) => {
          sent.push({ userId, text });
          return { messageId: "reminder-test" };
        },
      };
      const worker: Worker = createNotifyWorker({
        prisma: h.prisma,
        client: fakeClient,
        redisUrl: REDIS_URL,
        clientWritesLog: false,
      });
      await worker.waitUntilReady();

      await scheduler.schedule({ id: remindSlot.id, startsAt: remindSlot.startsAt });

      await waitUntil(() => sent.length > 0, 15_000);
      expect(sent[0]?.userId).toBe("1008-live");
      expect(sent[0]?.text).toContain("Напоминание");
      expect(sent[0]?.text).toContain("Н-9");

      await worker.close();
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      getRedis(REDIS_URL).quit().catch(() => undefined);
    }
  }, 60_000);
});
