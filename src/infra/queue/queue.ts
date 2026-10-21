import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Notification } from "../../domain/booking/booking.service.js";

export const NOTIFY_QUEUE = "notify";

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
 * Идемпотентность: jobId по событию, поэтому повторная отмена не плодит уведомления.
 */
export class QueueNotificationSink {
  constructor(private readonly queue: Queue) {}

  async notify(notification: Notification): Promise<void> {
    const scope = notification.slotId ?? notification.bookingId ?? "";
    // BullMQ 5 не принимает «:» в custom jobId ("Custom Id cannot contain :"),
    // поэтому разделитель — дефис; склейка всё равно однозначна.
    const jobId = `notify-${notification.kind}-${scope}-${notification.userId ?? ""}`.replace(
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
