import { describe, expect, it } from "vitest";
import {
  REMINDER_LEAD_HOURS,
  REMINDER_WINDOW_MIN,
  isReminderWithinWindow,
  reminderDelayMs,
  reminderText,
  reminderTriggerAt,
} from "../../src/domain/reminder/reminder.rules.js";

/**
 * Матрица §5.4 расширенного ТЗ, строка 8: напоминание за 24 ч ±5 мин.
 * Здесь — чистая математика окна; живая очередь — в matrix54.test.ts.
 */
describe("матрица №8: напоминание за 24 часа (окно ±5 мин)", () => {
  it("расчётное время = начало сессии − 24 часа", () => {
    const startsAt = new Date("2026-11-15T19:00:00.000Z");
    const trigger = reminderTriggerAt(startsAt);

    expect(REMINDER_LEAD_HOURS).toBe(24);
    expect(trigger.toISOString()).toBe("2026-11-14T19:00:00.000Z");
  });

  it("окно ±5 мин: расчётное время внутри, граница +5 мин внутри, +6 мин — уже нет", () => {
    const startsAt = new Date("2026-11-15T19:00:00.000Z");
    const expected = reminderTriggerAt(startsAt).getTime();

    expect(isReminderWithinWindow(expected, expected)).toBe(true);
    expect(isReminderWithinWindow(expected + REMINDER_WINDOW_MIN * 60_000, expected)).toBe(true);
    expect(isReminderWithinWindow(expected - REMINDER_WINDOW_MIN * 60_000, expected)).toBe(true);
    expect(isReminderWithinWindow(expected + (REMINDER_WINDOW_MIN + 1) * 60_000, expected)).toBe(false);
  });

  it("задержка до триггера: будущее — положительная, триггер прошёл — 0, сессия прошла — null", () => {
    const now = new Date("2026-11-10T12:00:00.000Z");

    // Начало через 24 ч + 1 ч → триггер через 1 ч.
    const future = new Date(now.getTime() + 25 * 3_600_000);
    expect(reminderDelayMs(future, now)).toBe(3_600_000);

    // Начало через 23 ч → триггер уже в прошлом: 0, не отрицательное.
    const imminent = new Date(now.getTime() + 23 * 3_600_000);
    expect(reminderDelayMs(imminent, now)).toBe(0);

    // Сессия уже началась — планировать нечего.
    expect(reminderDelayMs(new Date(now.getTime() - 1000), now)).toBeNull();

    // Фактическое срабатывание (now + delay) всегда в окне ±5 мин от расчётного.
    const startsAt = new Date(now.getTime() + 30 * 3_600_000);
    const delay = reminderDelayMs(startsAt, now) ?? -1;
    expect(isReminderWithinWindow(now.getTime() + delay, reminderTriggerAt(startsAt))).toBe(true);
  });

  it("текст напоминания несёт детали пересдачи: дисциплину, дату и аудиторию", () => {
    const text = reminderText({
      discipline: "Математический анализ",
      startsAt: new Date("2026-11-15T19:00:00.000Z"),
      room: "А-204",
    });

    expect(text).toContain("Напоминание");
    expect(text).toContain("Математический анализ");
    expect(text).toContain("А-204");
    expect(text).toContain("15.11"); // дата в русском формате
  });
});
