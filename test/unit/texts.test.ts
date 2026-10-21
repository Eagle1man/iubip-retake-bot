import { describe, expect, it } from "vitest";
import { texts, STUDENT_TEXT_KEYS } from "../../src/bot/texts.js";

/**
 * §10, §13.14: студент не должен видеть счётчик «записалось» ни в одном
 * студенческом шаблоне; у преподавателя счётчик в bookedList обязан остаться.
 */
const COUNTER_SUBSTR = /записалось|booked|счётчик/i;

function studentText(key: (typeof STUDENT_TEXT_KEYS)[number]): string {
  const value = texts.student[key];
  if (typeof value === "string") return value;
  const fn = value as (...args: unknown[]) => string;
  switch (key) {
    case "start":
      return fn();
    case "chooseSlot":
      return fn("Математический анализ");
    case "slotLine":
      return fn({ room: "А-204", startsAt: "10:00", amount: 500 });
    case "confirm":
      return fn({ fio: "Иванов Иван", group: "ГР-13", slot: "сессия" });
    case "created":
      return fn("B-1");
    case "receiptAccepted":
      return fn("B-1");
    case "receiptDuplicate":
      return fn("B-1");
    case "myBookings":
      return fn([]);
    case "bookingLine":
      return fn({
        number: "B-1",
        discipline: "МА",
        startsAt: "10:00",
        room: "А-1",
        status: "open",
      });
    case "cancelled":
      return fn("B-1");
    default:
      return fn();
  }
}

describe("texts.student", () => {
  it("ни один шаблон не содержит «Записалось»/«записалось»/«booked»/«счётчик»", () => {
    for (const key of STUDENT_TEXT_KEYS) {
      const rendered = studentText(key);
      expect(COUNTER_SUBSTR.test(rendered), `ключ ${key}: ${rendered}`).toBe(false);
    }
  });
});

describe("texts.teacher", () => {
  it("bookedList содержит счётчик «Записалось» — защита §13.14 (тест упадёт, если счётчик удалят)", () => {
    expect(texts.teacher.bookedList(5, [])).toContain("Записалось");
    expect(texts.teacher.bookedList(0, [])).toContain("Записалось: 0");
  });
});
