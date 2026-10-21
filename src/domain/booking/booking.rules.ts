/**
 * Правила записи. Чистые функции без Prisma — чтобы их можно было
 * проверить unit-тестами без базы (§11.1).
 */

export type BookingStatus = "submitted" | "paid" | "cancelled";

/** Активная запись — та, что держит место. cancelled место не держит. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ["submitted", "paid"];

export type BookingErrorCode =
  | "registration_closed"
  | "duplicate_active"
  | "receipt_used_elsewhere"
  | "booking_not_found"
  | "cancel_forbidden"
  | "slot_not_found"
  | "slot_cancelled"
  | "slot_conflict"
  | "registry_invalid";

export class BookingError extends Error {
  readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BookingError";
    this.code = code;
  }
}

export interface SlotLike {
  status: string;
  registrationDeadline: Date;
  startsAt: Date;
}

/** Запись открыта: слот существует, открыт и дедлайн регистрации не прошёл. */
export function isRegistrationOpen(slot: SlotLike, now: Date): boolean {
  if (slot.status !== "open") return false;
  return now.getTime() <= slot.registrationDeadline.getTime();
}

/** Можно ли отменить запись студентом. cancelDeadlineHours=0 — всегда можно. */
export function canCancelBooking(slot: SlotLike, now: Date, cancelDeadlineHours: number): boolean {
  if (cancelDeadlineHours <= 0) return true;
  const deadline = slot.startsAt.getTime() - cancelDeadlineHours * 3_600_000;
  return now.getTime() <= deadline;
}

/**
 * Запрещено ли создавать ещё одну активную запись на дисциплину.
 * Считается по уже существующим статусам, а не по количеству строк:
 * cancelled-записи не мешают.
 */
export function hasActiveBooking(existing: readonly BookingStatus[]): boolean {
  return existing.some((status) => (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(status));
}

/**
 * Тот же чек в ту же запись — повторная загрузка, идемпотентный 200.
 * Чек в ДРУГУЮ запись слота ловит уникальный индекс (receiptSha256, slotId) → 409.
 */
export function isSameReceipt(existingSha256: string | null | undefined, incomingSha256: string): boolean {
  if (!existingSha256) return false;
  return existingSha256 === incomingSha256;
}

/** Ключ дедуплицирования. paymentToken пуст → дедуплицировать нечем. */
export function dedupeKey(paymentToken: string | null | undefined, slotId: string): string | null {
  if (!paymentToken) return null;
  return `${slotId}::${paymentToken}`;
}

/** Слот подходит для выбора студентом. */
export function isSelectableSlot(slot: SlotLike, now: Date): boolean {
  return isRegistrationOpen(slot, now);
}
