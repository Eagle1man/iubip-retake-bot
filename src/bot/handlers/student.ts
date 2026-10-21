import type { BotContext } from "../dispatcher.js";
import { paymentTokenFor } from "../dispatcher.js";
import { BookingError } from "../../domain/booking/booking.rules.js";
import { bookingNumber } from "../../domain/staff/role.service.js";
import { btn, keyboard } from "../keyboards.js";
import { texts } from "../texts.js";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Список дисциплин или открытых сессий. Счётчик записавшихся студенту не показывается. */
export async function listOpenSlots(ctx: BotContext, disciplineId?: string): Promise<void> {
  const data = ctx.session.data;

  if (!disciplineId) {
    const disciplines = await ctx.deps.prisma.discipline.findMany({ orderBy: { name: "asc" } });
    if (disciplines.length === 0) {
      await ctx.send("Справочник дисциплин пуст.");
      return;
    }
    await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_DISCIPLINE", data);
    await ctx.send(
      texts.student.chooseDiscipline,
      keyboard([...disciplines.map((d) => [btn(d.name, `d:${d.id}`)])]),
    );
    return;
  }

  const discipline = await ctx.deps.prisma.discipline.findUnique({ where: { id: disciplineId } });
  if (!discipline) {
    await ctx.send(texts.system.unknown);
    return;
  }

  const slots = await ctx.deps.slots.listOpen(disciplineId);
  const open = slots.filter((s) => new Date(s.registrationDeadline).getTime() > Date.now());

  if (open.length === 0) {
    await ctx.send(texts.student.noSlots);
    return;
  }

  data.disciplineId = disciplineId;
  data.disciplineName = discipline.name;
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_SLOT", data);

  await ctx.send(
    texts.student.chooseSlot(discipline.name),
    keyboard([
      ...open.map((s) => [
        btn(texts.student.slotLine({ room: s.room, startsAt: fmt(s.startsAt), amount: 500 }), `s:${s.slotId}`),
      ]),
    ]),
  );
}

export async function handleDiscipline(ctx: BotContext, disciplineId: string): Promise<void> {
  ctx.session.data.disciplineId = disciplineId;
  await listOpenSlots(ctx, disciplineId);
}

export async function handleSlot(ctx: BotContext, slotId: string): Promise<void> {
  const slot = await ctx.deps.prisma.examSlot.findUnique({
    where: { id: slotId },
    include: { discipline: true },
  });
  if (!slot) {
    await ctx.send(texts.system.unknown);
    return;
  }

  ctx.session.data.slotId = slotId;
  ctx.session.data.slotLabel = `${fmt(slot.startsAt.toISOString())}, ауд. ${slot.room}`;
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_FIO", ctx.session.data);
  await ctx.send(`${texts.student.askFio}\n\nСессия: ${ctx.session.data.slotLabel}`);
}

export async function handleFio(ctx: BotContext, fio: string): Promise<void> {
  ctx.session.data.fio = fio.trim();
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_GROUP", ctx.session.data);
  await ctx.send(texts.student.askGroup);
}

export async function handleGroup(ctx: BotContext, group: string): Promise<void> {
  ctx.session.data.group = group.trim();
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_CONFIRM", ctx.session.data);
  await ctx.send(
    texts.student.confirm({
      fio: ctx.session.data.fio ?? "",
      group: ctx.session.data.group ?? "",
      slot: ctx.session.data.slotLabel ?? "",
    }),
    keyboard([[btn("Всё верно", "yes"), btn("Изменить ФИО", "restart")]]),
  );
}

export async function handleConfirm(ctx: BotContext): Promise<void> {
  const data = ctx.session.data;
  if (!data.slotId || !data.fio || !data.group) {
    await ctx.send(texts.system.unknown);
    return;
  }

  let result;
  try {
    result = await ctx.deps.bookings.create({
      slotId: data.slotId,
      studentUserId: ctx.event.userId,
      studentFio: data.fio,
      studentGroup: data.group,
      paymentToken: paymentTokenFor(ctx.event.userId, data.slotId),
    });
  } catch (error) {
    if (error instanceof BookingError) {
      if (error.code === "registration_closed") await ctx.send(texts.student.registrationClosed);
      else if (error.code === "duplicate_active") await ctx.send(texts.student.duplicate);
      else await ctx.send(texts.system.error);
      return;
    }
    throw error;
  }

  const booking = await ctx.deps.prisma.booking.findUnique({ where: { id: result.bookingId } });
  const number = booking ? bookingNumber(booking.seq) : result.bookingId.slice(0, 8);

  data.bookingId = result.bookingId;
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_RECEIPT_OR_SKIP", data);

  await ctx.send(
    texts.student.created(number),
    keyboard([[btn("Приложить чек", "attach_receipt"), btn("Пропустить", "skip_receipt")]]),
  );
}

export async function handleReceiptPrompt(ctx: BotContext): Promise<void> {
  if (!ctx.session.data.bookingId) {
    await ctx.send(texts.system.unknown);
    return;
  }
  await ctx.send("Пришлите файл чека следующим сообщением. Чек не обязателен: участие не блокируется.");
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_RECEIPT_FILE", ctx.session.data);
}

export async function handleReceiptSkip(ctx: BotContext): Promise<void> {
  const booking = ctx.session.data.bookingId
    ? await ctx.deps.prisma.booking.findUnique({ where: { id: ctx.session.data.bookingId } })
    : null;
  const number = booking ? bookingNumber(booking.seq) : "";
  await ctx.send(`${texts.student.admitted}\n\n${texts.student.receiptSkipped(number)}`);
  await ctx.deps.sessions.reset(ctx.event.userId);
}

export async function handleMyBookings(ctx: BotContext): Promise<void> {
  const bookings = await ctx.deps.prisma.booking.findMany({
    where: { studentUserId: ctx.event.userId },
    include: { slot: { include: { discipline: true } } },
    orderBy: { createdAt: "desc" },
  });

  const lines = bookings.map((b) =>
    texts.student.bookingLine({
      number: bookingNumber(b.seq),
      discipline: b.slot.discipline.name,
      startsAt: fmt(b.slot.startsAt.toISOString()),
      room: b.slot.room,
      status: b.status === "paid" ? "оплачено" : b.status === "cancelled" ? "отменено" : "принято",
    }),
  );

  // Кнопка отмены — на каждую запись: иначе отменить из бота нечим (§13: отмена студентом).
  const buttons = bookings
    .filter((b) => b.status !== "cancelled")
    .map((b) => [btn(`Отменить ${bookingNumber(b.seq)}`, `cancel:${b.id}`)]);

  await ctx.send(
    texts.student.myBookings(lines),
    buttons.length > 0 ? keyboard(buttons) : undefined,
  );
}

export async function handleCancel(ctx: BotContext, bookingId: string): Promise<void> {
  if (bookingId === "menu") {
    await handleMyBookings(ctx);
    return;
  }

  try {
    await ctx.deps.bookings.cancelByStudent(bookingId);
  } catch (error) {
    if (error instanceof BookingError && error.code === "cancel_forbidden") {
      await ctx.send(texts.student.cancelForbidden);
      return;
    }
    throw error;
  }

  const booking = await ctx.deps.prisma.booking.findUnique({ where: { id: bookingId } });
  await ctx.send(texts.student.cancelled(booking ? bookingNumber(booking.seq) : ""));
  await ctx.deps.sessions.reset(ctx.event.userId);
}
