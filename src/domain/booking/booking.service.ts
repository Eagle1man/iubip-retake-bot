import type { PrismaClient } from "@prisma/client";
import { BookingError, canCancelBooking, isRegistrationOpen, isSameReceipt } from "./booking.rules.js";

export interface NotificationSink {
  notify(input: Notification): Promise<void>;
}

export interface Notification {
  userId?: string | undefined;
  text: string;
  kind: string;
  slotId?: string | undefined;
  bookingId?: string | undefined;
}

export interface CreateBookingInput {
  slotId: string;
  studentUserId: string;
  studentFio: string;
  studentGroup: string;
  paymentToken?: string | undefined;
  amount?: number | undefined;
}

export interface CreateBookingResult {
  bookingId: string;
  status: string;
  deduplicated: boolean;
}

const HOUR_MS = 3_600_000;

export class BookingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationSink,
    private readonly cancelDeadlineHours: number,
    private readonly directorateChatId: string,
  ) {}

  /**
   * Создать запись идемпотентно.
   * Ошибки: registration_closed (410), duplicate_active (409), slot_not_found (404).
   * expectedCapacity здесь НЕ проверяется — он справочный (§13.13).
   */
  async create(input: CreateBookingInput, now: Date = new Date()): Promise<CreateBookingResult> {
    const slot = await this.prisma.examSlot.findUnique({
      where: { id: input.slotId },
    });

    if (!slot) throw new BookingError("slot_not_found", "Сессия не найдена");
    if (!isRegistrationOpen(slot, now)) {
      throw new BookingError("registration_closed", "Регистрация на эту сессию закрыта");
    }

    if (input.paymentToken) {
      const existing = await this.prisma.booking.findUnique({
        where: { paymentToken_slotId: { paymentToken: input.paymentToken, slotId: input.slotId } },
      });
      if (existing) {
        return { bookingId: existing.id, status: existing.status, deduplicated: true };
      }
    }

    const duplicate = await this.prisma.booking.findFirst({
      where: {
        disciplineId: slot.disciplineId,
        studentFio: { equals: input.studentFio, mode: "insensitive" },
        status: { in: ["submitted", "paid"] },
      },
    });
    if (duplicate) {
      throw new BookingError("duplicate_active", "Уже есть активная запись на эту дисциплину");
    }

    let bookingId: string;
    try {
      const created = await this.prisma.booking.create({
        data: {
          slotId: slot.id,
          disciplineId: slot.disciplineId,
          teacherId: slot.teacherId,
          studentUserId: input.studentUserId,
          studentFio: input.studentFio,
          studentGroup: input.studentGroup,
          paymentToken: input.paymentToken ?? null,
          amount: input.amount ?? 500,
        },
      });
      bookingId = created.id;
    } catch (error) {
      // Частичный уникальный индекс в БД — последняя линия защиты от дубля.
      if (isUniqueViolation(error)) {
        throw new BookingError("duplicate_active", "Уже есть активная запись на эту дисциплину");
      }
      throw error;
    }

    await this.maybeAlertOverflow(slot.id, slot.alertThreshold);

    return { bookingId, status: "submitted", deduplicated: false };
  }

  /**
   * Принять чек. Тот же чек в ту же запись — 200, тот же чек в другую запись слота — 409.
   */
  async attachReceipt(
    bookingId: string,
    receipt: { sha256: string; path: string },
  ): Promise<{ bookingId: string; deduplicated: boolean }> {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new BookingError("booking_not_found", "Запись не найдена");

    if (isSameReceipt(booking.receiptSha256, receipt.sha256)) {
      return { bookingId, deduplicated: true };
    }

    try {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { receiptSha256: receipt.sha256, receiptPath: receipt.path },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BookingError("receipt_used_elsewhere", "Чек уже приложен к другой записи на эту сессию");
      }
      throw error;
    }

    return { bookingId, deduplicated: false };
  }

  /** Отмена студентом. cancelDeadlineHours=0 → разрешена всегда. */
  async cancelByStudent(bookingId: string, now: Date = new Date()): Promise<{ bookingId: string }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { slot: true },
    });
    if (!booking) throw new BookingError("booking_not_found", "Запись не найдена");
    if (booking.status === "cancelled") return { bookingId };

    const slot = booking.slot;
    if (!canCancelBooking(slot, now, this.cancelDeadlineHours)) {
      throw new BookingError("cancel_forbidden", "Отмена уже невозможна: сессия близко");
    }

    await this.prisma.booking.update({ where: { id: bookingId }, data: { status: "cancelled" } });
    return { bookingId };
  }

  /** Отметка оплаты дирекцией: paid / unpaid (unpaid возвращает в submitted). */
  async setPayment(bookingId: string, paid: boolean): Promise<{ bookingId: string; status: string }> {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new BookingError("booking_not_found", "Запись не найдена");

    const status = paid ? "paid" : "submitted";
    if (booking.status === status) {
      // Статус не изменился: уведомлять не о чем. Иначе повторное нажатие
      // «Оплачено» слало бы второе уведомление о том же.
      return { bookingId, status };
    }
    await this.prisma.booking.update({ where: { id: bookingId }, data: { status } });

    if (paid) {
      await this.notifications.notify({
        userId: booking.studentUserId ?? undefined,
        kind: "payment_confirmed",
        bookingId,
        slotId: booking.slotId,
        text: `Оплата по записи подтверждена.`,
      });
    }

    return { bookingId, status };
  }

  /** Явка: attended / no_show. */
  async setAttendance(
    bookingId: string,
    attendance: "attended" | "no_show",
  ): Promise<{ bookingId: string; attendance: string }> {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new BookingError("booking_not_found", "Запись не найдена");

    await this.prisma.booking.update({ where: { id: bookingId }, data: { attendance } });
    return { bookingId, attendance };
  }

  /** Список записавшихся на слот: только для преподавателя и дирекции. */
  async listBySlot(slotId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { slotId, status: { not: "cancelled" } },
      orderBy: { studentFio: "asc" },
    });
    return bookings.map((booking) => ({
      bookingId: booking.id,
      studentFio: booking.studentFio,
      studentGroup: booking.studentGroup,
      paymentStatus: booking.status,
      hasReceipt: booking.receiptSha256 !== null,
      attendance: booking.attendance,
    }));
  }

  /** Напоминание: уведомить дирекцию при превышении порога. Не блокирует запись. */
  private async maybeAlertOverflow(slotId: string, alertThreshold: number): Promise<void> {
    try {
      const count = await this.prisma.booking.count({
        where: { slotId, status: { in: ["submitted", "paid"] } },
      });
      if (count > alertThreshold) {
        await this.notifications.notify({
          userId: this.directorateChatId,
          kind: "alert",
          slotId,
          text: `На сессию записалось ${count} человек при пороге ${alertThreshold}.`,
        });
      }
    } catch {
      // Уведомление не должно ломать запись.
    }
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** Часы до начала слота — для текстов бота. */
export function hoursUntil(startsAt: Date, now: Date): number {
  return Math.round((startsAt.getTime() - now.getTime()) / HOUR_MS);
}
