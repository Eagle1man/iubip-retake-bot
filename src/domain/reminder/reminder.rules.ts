/**
 * Правила напоминаний (расширенное ТЗ §5.4, строка 8).
 * Чистые функции: окно ±5 мин проверяется без очереди и без часов.
 */

/** Напоминание уходит за 24 часа до начала сессии (ТЗ). */
export const REMINDER_LEAD_HOURS = 24;
/** Окно срабатывания по ТЗ: ±5 минут от расчётного времени. */
export const REMINDER_WINDOW_MIN = 5;

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** Расчётное время напоминания: начало сессии минус ведущий интервал. */
export function reminderTriggerAt(startsAt: Date, leadHours: number = REMINDER_LEAD_HOURS): Date {
  return new Date(startsAt.getTime() - leadHours * HOUR_MS);
}

/**
 * Срабатывание укладывается в окно ±5 мин от расчётного времени.
 * trigger — фактическое время (или заявленная задержка), expected — расчётное.
 */
export function isReminderWithinWindow(
  trigger: Date | number,
  expected: Date | number,
  windowMin: number = REMINDER_WINDOW_MIN,
): boolean {
  const t = typeof trigger === "number" ? trigger : trigger.getTime();
  const e = typeof expected === "number" ? expected : expected.getTime();
  return Math.abs(t - e) <= windowMin * MIN_MS;
}

/** Текст напоминания: детали пересдачи (ТЗ §2, «напоминание за 24 часа»). */
export function reminderText(input: { discipline: string; startsAt: Date; room: string }): string {
  const when = input.startsAt.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Напоминание: пересдача «${input.discipline}» — ${when}, ауд. ${input.room}. Просим прийти заранее.`;
}

/**
 * Задержка до напоминания с учётом текущего времени.
 * Триггер уже прошёл (осталось меньше 24 часов) — отправляем немедленно,
 * но только если сессия ещё впереди; после начала напоминать бессмысленно.
 * Отрицательной задержки не бывает: BullMQ delay < 0 считается быстрым запуском,
 * но явное 0 честнее и проще для тестов.
 */
export function reminderDelayMs(
  startsAt: Date,
  now: Date = new Date(),
  leadHours: number = REMINDER_LEAD_HOURS,
): number | null {
  if (startsAt.getTime() <= now.getTime()) return null;
  const trigger = reminderTriggerAt(startsAt, leadHours).getTime();
  return Math.max(0, trigger - now.getTime());
}
