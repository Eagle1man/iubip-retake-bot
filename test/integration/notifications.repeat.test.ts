/**
 * Повторное событие должно доходить до получателя.
 *
 * Найдено гейтом 22.10.2026: jobId был детерминированным
 * (kind + slotId + userId), а BullMQ не добавляет дубль jobId и держит
 * завершённые джобы в наборе completed. Поэтому вторая смена аудитории
 * (или повторная отметка оплаты после сброса стенда) молча не отправлялась
 * вовсе: получатель просто не получал уведомление.
 *
 * Здесь: два одинаковых уведомления — два разных джоба.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queue } from "bullmq";
import { createNotifyQueue, getRedis, QueueNotificationSink } from "../../src/infra/queue/queue.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let queue: Queue;
let sink: QueueNotificationSink;

beforeAll(async () => {
  queue = createNotifyQueue(REDIS_URL);
  // Числим только свои джобы: счётчик в Redis общий с приложением.
  await queue.obliterate({ force: true }).catch(() => undefined);
  sink = new QueueNotificationSink(queue, getRedis(REDIS_URL));
});

afterAll(async () => {
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await getRedis(REDIS_URL).quit();
});

describe("jobId уведомления", () => {
  it("два одинаковых уведомления — два джоба (BullMQ не проглатывает повтор)", async () => {
    const notification = {
      userId: "1001",
      kind: "room_change",
      slotId: "slot-repeat",
      text: "Аудитория изменена: теперь Ауд-777.",
    };

    await sink.notify(notification);
    await sink.notify(notification);

    const jobs = await queue.getJobs(["waiting", "active", "delayed", "completed"]);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(2);
  });
});
