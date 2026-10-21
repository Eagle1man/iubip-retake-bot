import { describe, expect, it } from "vitest";
import {
  ACTIVE_BOOKING_STATUSES,
  canCancelBooking,
  dedupeKey,
  hasActiveBooking,
  isRegistrationOpen,
  isSameReceipt,
} from "../../src/domain/booking/booking.rules.js";

const slot = (overrides: Partial<{ status: string; registrationDeadline: Date; startsAt: Date }> = {}) => ({
  status: "open",
  registrationDeadline: new Date("2026-10-30T10:00:00Z"),
  startsAt: new Date("2026-10-31T09:00:00Z"),
  ...overrides,
});

describe("isRegistrationOpen", () => {
  it("открытая сессия до дедлайна", () => {
    expect(isRegistrationOpen(slot(), new Date("2026-10-21T00:00:00Z"))).toBe(true);
  });

  it("закрытая сессия", () => {
    expect(isRegistrationOpen(slot({ status: "closed" }), new Date("2026-10-21T00:00:00Z"))).toBe(false);
  });

  it("отменённая сессия", () => {
    expect(isRegistrationOpen(slot({ status: "cancelled" }), new Date("2026-10-21T00:00:00Z"))).toBe(false);
  });

  it("дедлайн прошёл", () => {
    expect(isRegistrationOpen(slot(), new Date("2026-10-30T10:00:01Z"))).toBe(false);
  });

  it("граница: now == deadline — ещё можно записаться", () => {
    expect(isRegistrationOpen(slot(), new Date("2026-10-30T10:00:00Z"))).toBe(true);
  });
});

describe("canCancelBooking", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  it("CANCEL_DEADLINE_HOURS=0 — отмена всегда разрешена", () => {
    expect(canCancelBooking(slot(), new Date("2026-10-31T08:59:00Z"), 0)).toBe(true);
  });

  it("за 25 часов до начала при лимите 24 — разрешена", () => {
    expect(canCancelBooking(slot(), new Date("2026-10-30T08:00:00Z"), 24)).toBe(true);
  });

  it("за 21 час до начала при лимите 24 — уже запрещена", () => {
    expect(canCancelBooking(slot(), now, 24)).toBe(false);
  });

  it("за 20 часов до начала при лимите 24 — запрещена", () => {
    expect(canCancelBooking(slot(), new Date("2026-10-30T13:00:00Z"), 24)).toBe(false);
  });
});

describe("hasActiveBooking", () => {
  it("активная submitted держит дисциплину", () => {
    expect(hasActiveBooking(["submitted"])).toBe(true);
  });

  it("активная paid держит дисциплину", () => {
    expect(hasActiveBooking(["paid"])).toBe(true);
  });

  it("cancelled не держит дисциплину", () => {
    expect(hasActiveBooking(["cancelled"])).toBe(false);
  });

  it("нет записей", () => {
    expect(hasActiveBooking([])).toBe(false);
  });

  it("список активных статусов ровно submitted и paid", () => {
    expect([...ACTIVE_BOOKING_STATUSES].sort()).toEqual(["paid", "submitted"]);
  });
});

describe("isSameReceipt", () => {
  it("тот же чек в ту же запись — повторная загрузка", () => {
    expect(isSameReceipt("abc", "abc")).toBe(true);
  });

  it("другой чек — не повтор", () => {
    expect(isSameReceipt("abc", "def")).toBe(false);
  });

  it("чека ещё нет — не повтор", () => {
    expect(isSameReceipt(null, "abc")).toBe(false);
    expect(isSameReceipt(undefined, "abc")).toBe(false);
  });
});

describe("dedupeKey", () => {
  it("токен и слот дают ключ", () => {
    expect(dedupeKey("pay_1_s1", "s1")).toBe("s1::pay_1_s1");
  });

  it("без токена ключа нет", () => {
    expect(dedupeKey(null, "s1")).toBeNull();
    expect(dedupeKey(undefined, "s1")).toBeNull();
    expect(dedupeKey("", "s1")).toBeNull();
  });
});
