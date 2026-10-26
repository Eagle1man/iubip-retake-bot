import { Worker, type Job } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { logger } from "../logger.js";
import { recordNotification } from "../notifications.js";
import { reminderText } from "../../domain/reminder/reminder.rules.js";
import type { MaxClient } from "../max/types.js";
import { NOTIFY_LIMITER, NOTIFY_QUEUE, REMIND_JOB, getRedis } from "./queue.js";

interface NotifyJob {
  userId?: string;
  text: string;
  kind: string;
  slotId?: string;
  bookingId?: string;
}

interface RemindJob {
  slotId: string;
}

/**
 * Воркер уведомлений.
 * В mock-режиме журнал пишет сам mock-клиент (§8 ТЗ), воркер только вызывает его.
 * В боевом режиме воркер ведёт журнал: queued → sent/failed.
 * Отдельное имя джобы — напоминание о сессии (расширенное ТЗ §5.4, строка 8).
 */
export function createNotifyWorker(options: {
  prisma: PrismaClient;
  client: MaxClient;
  redisUrl: string;
  /** true = mock-клиент уже пишет NotificationLog. */
  clientWritesLog: boolean;
  limiter?: { max: number; duration: number };
}): Worker {
  /** Отправка одного сообщения с журналом. Общая для notify и remind. */
  async function deliver(payload: NotifyJob): Promise<void> {
    const userId = payload.userId;
    if (!userId) return;

    let logId: string | undefined;
    if (!options.clientWritesLog) {
      logId = await recordNotification(options.prisma, {
        userId,
        kind: payload.kind,
        text: payload.text,
        status: "queued",
        slotId: payload.slotId,
        bookingId: payload.bookingId,
      });
    }

    try {
      await options.client.sendMessage(userId, payload.text, undefined, payload.kind);
      if (logId) {
        await options.prisma.notificationLog.update({
          where: { id: logId },
          data: { status: "sent", sentAt: new Date() },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Уведомление не отправлено", { userId, kind: payload.kind, error: message });
      if (logId) {
        await options.prisma.notificationLog.update({
          where: { id: logId },
          data: { status: "failed", error: message },
        });
      }
      throw error;
    }
  }

  /** Напоминание: слот жив, записавшиеся — активные (cancelled не уведомляем). */
  async function handleRemind(payload: RemindJob): Promise<{ sent: number; skipped?: string }> {
    const slot = await options.prisma.examSlot.findUnique({
      where: { id: payload.slotId },
      include: { discipline: true },
    });
    // Сессия отменена/закрыта после планирования — напоминать нечего.
    if (!slot || slot.status !== "open") return { sent: 0, skipped: "slot_unavailable" };

    const bookings = await options.prisma.booking.findMany({
      where: { slotId: slot.id, status: { in: ["submitted", "paid"] } },
      select: { studentUserId: true },
    });

    const text = reminderText({
      discipline: slot.discipline.name,
      startsAt: slot.startsAt,
      room: slot.room,
    });

    let sent = 0;
    for (const booking of bookings) {
      if (!booking.studentUserId) continue;
      await deliver({ userId: booking.studentUserId, text, kind: "reminder", slotId: slot.id });
      sent += 1;
    }
    return { sent };
  }

  const worker = new Worker(
    NOTIFY_QUEUE,
    async (job: Job) => {
      if (job.name === REMIND_JOB) {
        return handleRemind(job.data as RemindJob);
      }

      const payload = job.data as NotifyJob;
      await deliver(payload);
      return { ok: true };
    },
    {
      connection: getRedis(options.redisUrl),
      limiter: options.limiter ?? NOTIFY_LIMITER,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error("Джоб уведомления исчерпал попытки", {
      jobId: job?.id,
      name: job?.name,
      kind: job?.name === REMIND_JOB ? "reminder" : (job?.data as NotifyJob)?.kind,
      error: error.message,
    });
  });

  return worker;
}

export async function closeWorker(worker: Worker): Promise<void> {
  await worker.close();
}
