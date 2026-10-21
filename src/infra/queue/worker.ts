import { Worker, type Job } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { logger } from "../logger.js";
import { recordNotification } from "../notifications.js";
import type { MaxClient } from "../max/types.js";
import { NOTIFY_LIMITER, NOTIFY_QUEUE, getRedis } from "./queue.js";

interface NotifyJob {
  userId?: string;
  text: string;
  kind: string;
  slotId?: string;
  bookingId?: string;
}

/**
 * Воркер уведомлений.
 * В mock-режиме журнал пишет сам mock-клиент (§8 ТЗ), воркер только вызывает его.
 * В боевом режиме воркер ведёт журнал: queued → sent/failed.
 */
export function createNotifyWorker(options: {
  prisma: PrismaClient;
  client: MaxClient;
  redisUrl: string;
  /** true = mock-клиент уже пишет NotificationLog. */
  clientWritesLog: boolean;
  limiter?: { max: number; duration: number };
}): Worker {
  const worker = new Worker(
    NOTIFY_QUEUE,
    async (job: Job<NotifyJob>) => {
      const payload = job.data;
      const userId = payload.userId;
      if (!userId) return { skipped: true };

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
        return { ok: true };
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
      kind: job?.data.kind,
      error: error.message,
    });
  });

  return worker;
}

export async function closeWorker(worker: Worker): Promise<void> {
  await worker.close();
}
