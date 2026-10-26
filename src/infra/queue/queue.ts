import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Notification, ReminderScheduler } from "../../domain/booking/booking.service.js";
import { REMINDER_LEAD_HOURS, reminderDelayMs } from "../../domain/reminder/reminder.rules.js";

export const NOTIFY_QUEUE = "notify";
/** Имя джобы напоминания о сессии (расширенное ТЗ §5.4, строка 8). */
export const REMIND_JOB = "remind";

/** Throttling уведомлений (§2 ТЗ): не больше 30 сообщений в минуту. */
export const NOTIFY_LIMITER = { max: 30, duration: 60_000 };

let connection: Redis | undefined;

export function getRedis(redisUrl: string): Redis {
  if (!connection) {
    connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  }
  return connection;
}

export function createNotifyQueue(redisUrl: string): Queue {
  return new Queue(NOTIFY_QUEUE, {
    connection: getRedis(redisUrl),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
}

/**
 * Синхронный интерфейс домена → очередь.
 *
 * jobId уникален на КАЖДОЕ уведомление (счётчик в Redis). Раньше id был
 * детерминированным (kind + scope + userId) — и это ломало доставку: BullMQ
 * не добавляет дубль jobId, а завершённые джобы живут в наборе completed,
 * поэтому повторное событие (вторая смена аудитории, повторная отметка оплаты
 * после отмены/сброса) молча не отправлялось вовсе. Идемпотентность теперь
 * обеспечивает домен: уведомление уходит только при фактическом изменении.
 */
export class QueueNotificationSink {
  constructor(
    private readonly queue: Queue,
    private readonly redis: Redis,
  ) {}

  async notify(notification: Notification): Promise<void> {
    const scope = notification.slotId ?? notification.bookingId ?? "";
    // BullMQ 5 не принимает «:» в custom jobId ("Custom Id cannot contain :"),
    // поэтому разделитель — дефис; склейка всё равно однозначна.
    const seq = await this.redis.incr("notify:seq");
    const jobId = `notify-${notification.kind}-${scope}-${notification.userId ?? ""}-${seq}`.replace(
      /[^A-Za-z0-9_-]/g,
      "-",
    );

    await this.queue.add(
      "notify",
      {
        userId: notification.userId,
        text: notification.text,
        kind: notification.kind,
        slotId: notification.slotId,
        bookingId: notification.bookingId,
      },
      { jobId },
    );
  }
}

export async function closeQueue(queue: Queue, redis: Redis): Promise<void> {
  await queue.close();
  await redis.quit();
  connection = undefined;
}

/**
 * Планировщик напоминаний на BullMQ: delayed-джоба с jobId по слоту.
 *
 * Дедуплицирует повторы сам BullMQ: jobId `remind-<slotId>` второй раз не
 * добавится, пока первая джоба живёт в очереди (выполненная — в completed).
 * Записи после триггера (осталось меньше 24 ч) планируются с задержкой 0 —
 * напоминание уходит сразу, сессия ещё впереди.
 */
export class QueueReminderScheduler implements ReminderScheduler {
  constructor(
    private readonly queue: Queue,
    private readonly enabled: boolean,
    private readonly leadHours: number = REMINDER_LEAD_HOURS,
  ) {}

  async schedule(slot: { id: string; startsAt: Date }): Promise<void> {
    if (!this.enabled) return;

    const delay = reminderDelayMs(slot.startsAt, new Date(), this.leadHours);
    if (delay === null) return; // сессия уже началась — напоминать не о чем

    const jobId = `remind-${slot.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
    await this.queue.add(
      REMIND_JOB,
      { slotId: slot.id },
      {
        jobId,
        delay,
        // Напоминание не должно умирать молча при сетевом сбое.
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    );
  }
}
