import type { PrismaClient } from "@prisma/client";
import { BookingError } from "../booking/booking.rules.js";
import type { NotificationSink } from "../booking/booking.service.js";
import type { ParsedRow } from "./csv.parser.js";
import { normalizeFio, parseRegistryCsv } from "./csv.parser.js";

export interface ImportResult {
  rowsTotal: number;
  rowsMatched: number;
  rowsUnmatched: string[];
}

interface BookingLite {
  id: string;
  studentFio: string;
  studentUserId: string | null;
  amount: number;
  slotId: string;
}

/**
 * Простой CSV-импорт для MVP (§9 ТЗ).
 * Сопоставление: сначала по ФИО + сумме, затем только по ФИО.
 * Несопоставленные НЕ помечаются оплаченными — возвращаются списком.
 */
export class RegistryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationSink,
  ) {}

  async importCsv(text: string, fileName: string): Promise<ImportResult> {
    let rows: ParsedRow[];
    try {
      rows = parseRegistryCsv(text);
    } catch (error) {
      // Битый CSV — ошибка данных (400), а не сбой сервера.
      throw new BookingError("registry_invalid", error instanceof Error ? error.message : "Некорректный реестр");
    }

    const active = await this.prisma.booking.findMany({
      where: { status: { in: ["submitted", "paid"] } },
      select: { id: true, studentFio: true, studentUserId: true, amount: true, slotId: true },
    });

    const byFioAndAmount = new Map<string, BookingLite>();
    const byFio = new Map<string, BookingLite>();
    const ambiguous = new Set<string>();

    for (const booking of active) {
      const key = normalizeFio(booking.studentFio);
      byFioAndAmount.set(`${key}|${booking.amount}`, booking);

      const already = byFio.get(key);
      if (already && already.id !== booking.id) {
        ambiguous.add(key);
      } else if (!already) {
        byFio.set(key, booking);
      }
    }

    const assignments: { row: ParsedRow; booking: BookingLite | null }[] = [];
    const unmatchedFios: string[] = [];

    for (const row of rows) {
      if (row.errors.length > 0) {
        unmatchedFios.push(row.fio);
        continue;
      }

      let booking = byFioAndAmount.get(`${row.fioNorm}|${row.amount}`);
      if (!booking && !ambiguous.has(row.fioNorm)) booking = byFio.get(row.fioNorm);

      assignments.push({ row, booking: booking ?? null });
      if (!booking) unmatchedFios.push(row.fio);
    }

    const importRecord = await this.prisma.registryImport.create({
      data: {
        fileName,
        rowsTotal: rows.length,
        rowsMatched: assignments.filter((a) => a.booking !== null).length,
        rowsUnmatched: unmatchedFios.length,
        unmatchedFios,
      },
    });

    for (const { row, booking } of assignments) {
      await this.prisma.registryRow.create({
        data: {
          importId: importRecord.id,
          payerFio: row.fio,
          payerFioNorm: row.fioNorm,
          amount: row.amount,
          paidAt: row.paidAt,
          purpose: row.purpose,
          matchedBookingId: booking?.id ?? null,
        },
      });
    }

    for (const { booking } of assignments) {
      if (!booking) continue;
      const current = await this.prisma.booking.findUnique({ where: { id: booking.id } });
      if (!current || current.status === "paid") continue;

      await this.prisma.booking.update({ where: { id: booking.id }, data: { status: "paid" } });

      if (booking.studentUserId) {
        await this.notifications.notify({
          userId: booking.studentUserId,
          kind: "payment_confirmed",
          bookingId: booking.id,
          slotId: booking.slotId,
          text: "Оплата подтверждена по реестру.",
        });
      }
    }

    return {
      rowsTotal: rows.length,
      // Сколько строк нашли свою запись, а не сколько переключили в paid:
      // повторный импорт тех же денег — это тоже совпадение, а не «ноль найденных».
      rowsMatched: assignments.filter((a) => a.booking !== null).length,
      rowsUnmatched: unmatchedFios,
    };
  }
}
