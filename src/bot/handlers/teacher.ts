import type { BotContext } from "../dispatcher.js";
import { bookingNumber } from "../../domain/staff/role.service.js";
import { btn, keyboard } from "../keyboards.js";
import { texts } from "../texts.js";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export async function handleTeacherGreeting(ctx: BotContext): Promise<void> {
  const teacher = await ctx.deps.roles.findTeacherByUserId(ctx.event.userId);
  await ctx.send(texts.teacher.greeting(teacher?.fio ?? ""), teacherKeyboard());
}

export function teacherKeyboard() {
  return keyboard([
    [btn("Мои сессии", "my_slots")],
    [btn("Создать сессию", "create_slot")],
  ]);
}

export async function handleMySlots(ctx: BotContext): Promise<void> {
  const teacher = await ctx.deps.roles.findTeacherByUserId(ctx.event.userId);
  if (!teacher) {
    await ctx.send(texts.teacher.notTeacher);
    return;
  }

  const slots = await ctx.deps.prisma.examSlot.findMany({
    where: { teacherId: teacher.id },
    include: { discipline: true },
    orderBy: { startsAt: "asc" },
  });

  const lines = await Promise.all(
    slots.map(async (slot) => {
      const booked = await ctx.deps.prisma.booking.count({
        where: { slotId: slot.id, status: { in: ["submitted", "paid"] } },
      });
      return texts.teacher.slotLine({
        slotId: slot.id,
        discipline: slot.discipline.name,
        startsAt: fmt(slot.startsAt.toISOString()),
        room: slot.room,
        booked,
      });
    }),
  );

  await ctx.send(texts.teacher.mySlots(lines), slotActionsKeyboard(slots.map((s) => s.id)));
}

export function slotActionsKeyboard(slotIds: string[]) {
  return keyboard([
    ...slotIds.map((id) => [
      btn("Список записавшихся", `booked:${id}`),
      btn("Закрыть", `close:${id}`),
      btn("Отменить", `cancel_slot:${id}`),
    ]),
  ]);
}

export async function handleBookedList(ctx: BotContext, slotId: string): Promise<void> {
  const slot = await ctx.deps.prisma.examSlot.findUnique({ where: { id: slotId }, include: { discipline: true } });
  if (!slot) {
    await ctx.send(texts.teacher.slotNotFound);
    return;
  }

  const list = await ctx.deps.slots.listBooked(slotId);
  const lines = list.students.map((student) =>
    texts.teacher.studentLine({
      fio: student.studentFio,
      group: student.studentGroup,
      paymentStatus: student.paymentStatus,
      hasReceipt: student.hasReceipt,
      attendance: student.attendance,
    }),
  );

  await ctx.send(
    `${slot.discipline.name}, ${fmt(slot.startsAt.toISOString())}, ауд. ${slot.room}\n\n${texts.teacher.bookedList(
      list.total,
      lines,
    )}`,
    attendanceKeyboard(list.students),
  );
}

function attendanceKeyboard(
  students: { bookingId: string; studentFio: string }[],
) {
  return keyboard([
    ...students.map((s) => [
      btn(`Явка: ${s.studentFio}`, `attend:${s.bookingId}:attended`),
      btn(`Нет: ${s.studentFio}`, `attend:${s.bookingId}:no_show`),
    ]),
  ]);
}

export async function handleAttendance(ctx: BotContext, bookingId: string, value: string): Promise<void> {
  const attendance = value === "attended" || value === "no_show" ? value : null;
  if (!attendance) {
    await ctx.send(texts.system.unknown);
    return;
  }
  await ctx.deps.bookings.setAttendance(bookingId, attendance);
  const booking = await ctx.deps.prisma.booking.findUnique({ where: { id: bookingId } });
  await ctx.send(`${texts.teacher.attendanceMarked} Запись: ${booking ? bookingNumber(booking.seq) : bookingId}.`);
}

export async function handleCloseSlot(ctx: BotContext, slotId: string): Promise<void> {
  await ctx.deps.slots.close(slotId);
  await ctx.send(texts.teacher.slotClosed);
}

export async function handleCancelSlot(ctx: BotContext, slotId: string): Promise<void> {
  const result = await ctx.deps.slots.cancel(slotId);
  await ctx.send(texts.teacher.slotCancelled(result.notified));
}

/** Создание сессии: выбор преподавателя (для дирекции) или он сам. */
export async function handleCreateSlot(ctx: BotContext): Promise<void> {
  if (ctx.role === "directorate") {
    const teachers = await ctx.deps.prisma.teacher.findMany({ orderBy: { fio: "asc" } });
    await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_SLOT_TEACHER", ctx.session.data);
    await ctx.send(
      texts.teacher.askFio,
      keyboard([...teachers.map((t) => [btn(t.fio, `teacher:${t.id}`)])]),
    );
    return;
  }

  const teacher = await ctx.deps.roles.findTeacherByUserId(ctx.event.userId);
  if (!teacher) {
    await ctx.send(texts.teacher.notTeacher);
    return;
  }

  ctx.session.data.teacherId = teacher.id;
  await askDiscipline(ctx);
}

export async function handleTeacherChosen(ctx: BotContext, teacherId: string): Promise<void> {
  ctx.session.data.teacherId = teacherId;
  await askDiscipline(ctx);
}

async function askDiscipline(ctx: BotContext): Promise<void> {
  const disciplines = await ctx.deps.prisma.discipline.findMany({ orderBy: { name: "asc" } });
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_SLOT_DISCIPLINE", ctx.session.data);
  await ctx.send(texts.teacher.askDiscipline, keyboard([...disciplines.map((d) => [btn(d.name, `sd:${d.id}`)])]));
}

export async function handleSlotDiscipline(ctx: BotContext, disciplineId: string): Promise<void> {
  ctx.session.data.slotDisciplineId = disciplineId;
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_SLOT_STARTS_AT", ctx.session.data);
  await ctx.send(texts.teacher.askStartsAt);
}

export async function handleSlotStartsAt(ctx: BotContext, value: string): Promise<void> {
  const startsAt = parseDateTime(value);
  if (!startsAt) {
    await ctx.send("Не понял дату. Формат: ГГГГ-ММ-ДД ЧЧ:ММ");
    return;
  }
  ctx.session.data.slotStartsAt = startsAt.toISOString();
  await ctx.deps.sessions.set(ctx.event.userId, "AWAIT_SLOT_ROOM", ctx.session.data);
  await ctx.send(texts.teacher.askRoom);
}

export async function handleSlotRoom(ctx: BotContext, room: string): Promise<void> {
  const data = ctx.session.data;
  if (!data.teacherId || !data.slotDisciplineId || !data.slotStartsAt) {
    await ctx.send(texts.system.unknown);
    return;
  }

  const created = await ctx.deps.slots.create({
    disciplineId: data.slotDisciplineId,
    teacherId: data.teacherId,
    startsAt: new Date(data.slotStartsAt),
    room: room.trim(),
    expectedCapacity: 30,
    alertThreshold: 30,
    registrationDeadline: new Date(new Date(data.slotStartsAt).getTime() - 24 * 3_600_000),
  });

  await ctx.send(texts.teacher.slotCreated(created.slotId));
  await ctx.deps.sessions.reset(ctx.event.userId);
}

/** Разбор «ГГГГ-ММ-ДД ЧЧ:ММ» в локальном времени. */
export function parseDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isNaN(date.getTime()) ? null : date;
}
