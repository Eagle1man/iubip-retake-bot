import type { BotContext } from "../dispatcher.js";
import { BookingError } from "../../domain/booking/booking.rules.js";
import { bookingNumber, findByNumber } from "../../domain/staff/role.service.js";
import { btn, keyboard } from "../keyboards.js";
import { texts } from "../texts.js";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function directorateKeyboard() {
  return keyboard([
    [btn("Все сессии", "all_slots")],
    [btn("Записи", "all_bookings")],
    [btn("Отметить оплату", "pay")],
    [btn("Импорт реестра", "import")],
    [btn("Сменить аудиторию", "room")],
    [btn("Создать сессию", "create_slot")],
    [btn("Выгрузить CSV", "export")],
  ]);
}

export async function handleDirectorateGreeting(ctx: BotContext): Promise<void> {
  await ctx.send(texts.directorate.greeting, directorateKeyboard());
}

export async function handleAllSlots(ctx: BotContext): Promise<void> {
  const slots = await ctx.deps.slots.listOpen(undefined);
  const lines = slots.map(
    (s) => `${s.discipline} · ${fmt(s.startsAt)} · ауд. ${s.room} · Записалось: ${s.bookedCount}`,
  );
  await ctx.send(texts.directorate.allSlots(lines));
}

export async function handleAllBookings(ctx: BotContext, status?: string): Promise<void> {
  const bookings = await ctx.deps.prisma.booking.findMany({
    where: status ? { status } : { status: { not: "cancelled" } },
    include: { slot: { include: { discipline: true, teacher: true } } },
    orderBy: { seq: "asc" },
  });

  const lines = bookings.map(
    (b) =>
      `${bookingNumber(b.seq)} · ${b.studentFio} · ${b.studentGroup} · ${b.slot.discipline.name} · ${
        b.slot.teacher.fio
      } · ${fmt(b.slot.startsAt.toISOString())} · оплата: ${b.status}`,
  );

  await ctx.send(texts.directorate.bookingsByStatus(lines));
}

export async function handlePaymentMenu(ctx: BotContext): Promise<void> {
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_PAYMENT_TARGET", ctx.session.data);
  await ctx.send(texts.directorate.askBookingNumber);
}

export async function handlePaymentTarget(ctx: BotContext, value: string): Promise<void> {
  const booking = await findByNumber(ctx.deps.prisma, value);
  if (!booking) {
    await ctx.send(texts.directorate.bookingNotFound);
    return;
  }

  ctx.session.data.paymentBookingId = booking.id;
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_PAYMENT_CONFIRM", ctx.session.data);
  await ctx.send(
    `Запись ${bookingNumber(booking.seq)} · ${booking.studentFio} · ${booking.studentGroup}\nТекущий статус: ${booking.status}`,
    keyboard([
      [btn("Оплачено", `pay:${booking.id}:paid`), btn("Не оплачено", `pay:${booking.id}:unpaid`)],
    ]),
  );
}

export async function handlePayment(ctx: BotContext, bookingId: string, paid: boolean): Promise<void> {
  await ctx.deps.bookings.setPayment(bookingId, paid);
  const booking = await ctx.deps.prisma.booking.findUnique({ where: { id: bookingId } });
  await ctx.send(
    texts.directorate.paymentMarked(booking ? bookingNumber(booking.seq) : bookingId, paid ? "оплачено" : "не оплачено"),
  );
  await ctx.deps.sessions.reset(ctx.event.userId);
}

export async function handleImportPrompt(ctx: BotContext): Promise<void> {
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_REGISTRY_FILE", ctx.session.data);
  await ctx.send(texts.directorate.askRegistryFile);
}

/** Реестр приходит текстом (mock) или файлом (боевой режим). */
export async function handleImport(ctx: BotContext, csv: string): Promise<void> {
  try {
    const result = await ctx.deps.registry.importCsv(csv, "from-bot.csv");
    await ctx.send(texts.directorate.importResult(result));
  } catch (error) {
    await ctx.send(error instanceof Error ? error.message : texts.system.error);
  }
  await ctx.deps.sessions.reset(ctx.event.userId);
}

export async function handleRoomMenu(ctx: BotContext): Promise<void> {
  const slots = await ctx.deps.prisma.examSlot.findMany({
    where: { status: "open" },
    include: { discipline: true },
    orderBy: { startsAt: "asc" },
  });

  if (slots.length === 0) {
    await ctx.send("Открытых сессий нет.");
    return;
  }

  await ctx.send(
    "Выберите сессию:",
    keyboard([
      ...slots.map((s) => [
        btn(`${s.discipline.name} · ${fmt(s.startsAt.toISOString())} · ауд. ${s.room}`, `pick_room:${s.id}`),
      ]),
    ]),
  );
}

export async function handleRoomPicked(ctx: BotContext, slotId: string): Promise<void> {
  ctx.session.data.slotId = slotId;
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_ROOM", ctx.session.data);
  await ctx.send(texts.directorate.askRoom);
}

export async function handleRoom(ctx: BotContext, room: string): Promise<void> {
  const slotId = ctx.session.data.slotId;
  if (!slotId) {
    await ctx.send(texts.system.unknown);
    return;
  }
  const result = await ctx.deps.slots.updateRoom(slotId, room.trim());
  await ctx.send(texts.directorate.roomChanged(result.notified));
  await ctx.deps.sessions.reset(ctx.event.userId);
}

export async function handleCancelSlot(ctx: BotContext, slotId: string): Promise<void> {
  try {
    const result = await ctx.deps.slots.cancel(slotId);
    await ctx.send(texts.directorate.slotCancelled(result.notified));
  } catch (error) {
    if (error instanceof BookingError && error.code === "slot_cancelled") {
      await ctx.send(texts.directorate.slotAlreadyCancelled);
      return;
    }
    throw error;
  }
}

export async function handleExport(ctx: BotContext): Promise<void> {
  await ctx.send(texts.directorate.exportLink);
}
