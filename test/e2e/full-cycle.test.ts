import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, findCallback, resetDb, type Harness } from "../helpers/harness.js";
import { seedBase, seedRoles, type SeedBase } from "../helpers/data.js";
import { bookingNumber } from "../../src/domain/staff/role.service.js";

/**
 * E2E полного цикла (§11.3 ТЗ) — один сквозной сценарий через mock-инъекции:
 * deep link → выбор сессии → ФИО/группа → подтверждение → пропуск чека →
 * bookedCount=1 → оплата дирекцией → выгрузка CSV → отмена сессии и уведомление.
 * В сеть не ходит, токен MAX не нужен.
 */

const STUDENT = "1001";
const DIRECTORATE = "3001";

let h: Harness;
let base: SeedBase;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  base = await seedBase(h.prisma);
  await seedRoles(h.prisma);
});

afterAll(async () => {
  await h.close();
});

const inject = (userId: string, body: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url: "/mock/max/inject", payload: { userId, ...body } });

it("§11.3: полный цикл записи от deep link до отмены сессии", async () => {
  // 1–2. Seed уже есть; deep link /start rt_<дисциплина>_<сессия>
  const start = await inject(STUDENT, { text: `/start ${base.token}` });
  expect(start.statusCode).toBe(200);

  // 3. Дисциплина выбрана токеном — остаётся выбрать сессию
  const slotButton = await findCallback(h.prisma, STUDENT, "s:");
  expect(slotButton).toBe(`s:${base.slotId}`);
  expect(await inject(STUDENT, { callbackData: slotButton })).toMatchObject({ statusCode: 200 });

  // 4. ФИО → группа → подтверждение → чек пропускаем
  expect((await inject(STUDENT, { text: "Иванов Иван Иванович" })).statusCode).toBe(200);
  expect((await inject(STUDENT, { text: "ГР-91" })).statusCode).toBe(200);

  const confirmButton = await findCallback(h.prisma, STUDENT, "yes");
  expect(confirmButton).toBe("yes");
  await inject(STUDENT, { callbackData: confirmButton });

  const skipButton = await findCallback(h.prisma, STUDENT, "skip_receipt");
  expect(skipButton).toBe("skip_receipt");
  await inject(STUDENT, { callbackData: skipButton });

  const booking = await h.prisma.booking.findFirst({ where: { studentUserId: STUDENT } });
  expect(booking).not.toBeNull();
  expect(booking?.status).toBe("submitted");
  expect(booking?.studentFio).toBe("Иванов Иван Иванович");

  // 5. Счётчик записавшихся виден API (но не студенту — это проверяет texts.test)
  const slotsRes = await h.app.inject({
    method: "GET",
    url: `/internal/slots?disciplineId=${base.disciplineId}`,
    headers: h.headers,
  });
  const slot = (slotsRes.json() as { slotId: string; bookedCount: number }[]).find(
    (s) => s.slotId === base.slotId,
  );
  expect(slot?.bookedCount).toBe(1);

  // 6. Дирекция отмечает оплату через бота: меню → номер записи → «Оплачено»
  expect((await inject(DIRECTORATE, { text: "Отметить оплату" })).statusCode).toBe(200);
  const number = bookingNumber(booking?.seq ?? 0);
  expect((await inject(DIRECTORATE, { text: number })).statusCode).toBe(200);

  const payButton = await findCallback(h.prisma, DIRECTORATE, "pay:");
  expect(payButton).toBe(`pay:${booking?.id}:paid`);
  await inject(DIRECTORATE, { callbackData: payButton });

  const paid = await h.prisma.booking.findUnique({ where: { id: booking?.id as string } });
  expect(paid?.status).toBe("paid");

  // 7. Выгрузка CSV содержит строку со статусом оплаты
  const csv = await h.app.inject({
    method: "GET",
    url: "/internal/export/bookings.csv",
    headers: h.headers,
  });
  expect(csv.statusCode).toBe(200);
  const row = csv.body.split("\n").find((line) => line.startsWith(`${number},`));
  expect(row).toBeDefined();
  expect(row).toContain(",paid,");
  expect(row).toContain("Иванов Иван Иванович");

  // 8. Отмена сессии → записанным уведомление с kind='slot_cancelled'
  const cancel = await h.app.inject({
    method: "POST",
    url: `/internal/slots/${base.slotId}/cancel`,
    headers: h.headers,
  });
  expect(cancel.statusCode).toBe(200);
  expect(cancel.json()).toMatchObject({ cancelled: true, notified: 1 });

  const notice = await h.prisma.notificationLog.findFirst({
    where: { userId: STUDENT, kind: "slot_cancelled" },
  });
  expect(notice).not.toBeNull();
  expect(notice?.text).toContain("Сессия отменена");
  expect(notice?.status).toBe("sent");

  // §11.2/§12: то же уведомление видно в mock-истории эмулятора
  const history = await h.app.inject({ method: "GET", url: `/mock/history?userId=${STUDENT}` });
  expect(history.statusCode).toBe(200);
  const messages = (history.json() as { messages: { kind: string }[] }).messages;
  expect(messages.some((m) => m.kind === "slot_cancelled")).toBe(true);
}, 60_000);
