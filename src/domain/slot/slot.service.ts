import type { PrismaClient } from "@prisma/client";
import { BookingError } from "../booking/booking.rules.js";
import type { NotificationSink } from "../booking/booking.service.js";

export interface CreateSlotInput {
  disciplineId: string;
  teacherId: string;
  startsAt: Date;
  room: string;
  expectedCapacity: number;
  alertThreshold: number;
  registrationDeadline: Date;
}

const HOUR_MS = 3_600_000;

export class SlotService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationSink,
  ) {}

  /** Открытые сессии. bookedCount считается одним groupBy, а не N+1. */
  async listOpen(disciplineId: string | undefined, now: Date = new Date()) {
    const slots = await this.prisma.examSlot.findMany({
      where: {
        status: "open",
        registrationDeadline: { gt: now },
        ...(disciplineId ? { disciplineId } : {}),
      },
      orderBy: { startsAt: "asc" },
      include: { discipline: true, teacher: true },
    });

    if (slots.length === 0) return [];

    const counts = await this.prisma.booking.groupBy({
      by: ["slotId"],
      where: { slotId: { in: slots.map((s) => s.id) }, status: { in: ["submitted", "paid"] } },
      _count: { _all: true },
    });
    const countBySlot = new Map(counts.map((c) => [c.slotId, c._count._all]));

    return slots.map((slot) => ({
      slotId: slot.id,
      disciplineId: slot.disciplineId,
      discipline: slot.discipline.name,
      teacherId: slot.teacherId,
      teacher: slot.teacher.fio,
      startsAt: slot.startsAt.toISOString(),
      room: slot.room,
      registrationDeadline: slot.registrationDeadline.toISOString(),
      expectedCapacity: slot.expectedCapacity,
      bookedCount: countBySlot.get(slot.id) ?? 0,
    }));
  }

  async create(input: CreateSlotInput) {
    if (input.registrationDeadline.getTime() > input.startsAt.getTime()) {
      throw new BookingError("slot_conflict", "Дедлайн регистрации не может быть позже начала сессии");
    }
    const clash = await this.prisma.examSlot.findFirst({
      where: { teacherId: input.teacherId, startsAt: input.startsAt, status: { not: "cancelled" } },
    });
    if (clash) throw new BookingError("slot_conflict", "У этого преподавателя уже есть сессия в это время");

    const created = await this.prisma.examSlot.create({ data: input });
    return { slotId: created.id, status: created.status };
  }

  /** Смена аудитории + уведомление всем записанным. */
  async updateRoom(slotId: string, room: string) {
    const slot = await this.prisma.examSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw new BookingError("slot_not_found", "Сессия не найдена");

    await this.prisma.examSlot.update({ where: { id: slotId }, data: { room } });

    const notified = await this.notifyStudents(slot.id, (userId) =>
      this.notifications.notify({
        userId,
        kind: "room_change",
        slotId,
        text: `Аудитория изменена: теперь ${room}.`,
      }),
    );

    return { updated: true, notified };
  }

  /** Отмена сессии: слот cancelled, записи остаются, всем записанным уведомление. */
  async cancel(slotId: string) {
    const slot = await this.prisma.examSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw new BookingError("slot_not_found", "Сессия не найдена");
    if (slot.status === "cancelled") throw new BookingError("slot_cancelled", "Сессия уже отменена");

    await this.prisma.examSlot.update({ where: { id: slotId }, data: { status: "cancelled" } });

    const notified = await this.notifyStudents(slot.id, (userId) =>
      this.notifications.notify({
        userId,
        kind: "slot_cancelled",
        slotId,
        text: "Сессия отменена. Запись остаётся в истории, но пересдача не состоится.",
      }),
    );

    return { cancelled: true, notified };
  }

  /** Закрытие сессии без отмены — новых записей нет, уведомлений нет. */
  async close(slotId: string) {
    await this.prisma.examSlot.update({ where: { id: slotId }, data: { status: "closed" } });
    return { closed: true };
  }

  /** Список записавшихся: только преподавателю и дирекции (§10). */
  async listBooked(slotId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { slotId, status: { not: "cancelled" } },
      orderBy: { studentFio: "asc" },
    });

    return {
      slotId,
      total: bookings.length,
      students: bookings.map((booking) => ({
        bookingId: booking.id,
        studentFio: booking.studentFio,
        studentGroup: booking.studentGroup,
        paymentStatus: booking.status,
        hasReceipt: booking.receiptSha256 !== null,
        attendance: booking.attendance,
      })),
    };
  }

  /** Уведомить всех активных записавшихся сессии. Возвращает число уведомлённых. */
  private async notifyStudents(
    slotId: string,
    send: (userId: string) => Promise<void>,
  ): Promise<number> {
    const bookings = await this.prisma.booking.findMany({
      where: { slotId, status: { in: ["submitted", "paid"] } },
      select: { studentUserId: true },
    });

    let notified = 0;
    for (const booking of bookings) {
      if (!booking.studentUserId) continue;
      await send(booking.studentUserId);
      notified += 1;
    }
    return notified;
  }
}

export { HOUR_MS };
