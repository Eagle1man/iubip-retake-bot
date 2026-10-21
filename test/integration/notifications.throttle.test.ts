import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queue, Worker } from "bullmq";
import { createHarness, resetDb, type Harness } from "../helpers/harness.js";
import { createNotifyQueue, getRedis, NOTIFY_LIMITER, QueueNotificationSink } from "../../src/infra/queue/queue.js";
import { createNotifyWorker } from "../../src/infra/queue/worker.js";
import type { MaxClient } from "../../src/infra/max/types.js";

/**
 * Throttling уведомлений (§2 ТЗ: не больше 30 сообщений в минуту).
 * Нужны живые Redis и BullMQ: проверяется именно лимит воркера, а не заглушка.
 */
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const JOBS = 35;

let h: Harness;
let worker: Worker;
let queue: Queue;
let sink: QueueNotificationSink;
let close: () => Promise<void>;
const sent: string[] = [];

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);

  queue = createNotifyQueue(REDIS_URL);
  // Остатки прошлых прогонов не должны влиять на замер.
  await queue.obliterate({ force: true }).catch((error) => console.log("[diag] obliterate:", String(error)));

  const fakeClient: MaxClient = {
    sendMessage: async (userId: string) => {
      sent.push(userId);
      return { messageId: "test" };
    },
  };

  worker = createNotifyWorker({
    prisma: h.prisma,
    client: fakeClient,
    redisUrl: REDIS_URL,
    clientWritesLog: false,
  });
  await worker.waitUntilReady();

  sink = new QueueNotificationSink(queue, getRedis(REDIS_URL));
  close = async () => {
    await worker.close();
    // Добиваем очередь: иначе не отправленные за окно уведомления уедут
    // в следующий запуск приложения и человек увидит чужие сообщения.
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await getRedis(REDIS_URL).quit();
  };
}, 60_000);

afterAll(async () => {
  await close?.();
  await h.close();
});

describe("очередь уведомлений (§2 throttling)", () => {
  it(`лимит ${NOTIFY_LIMITER.max} сообщений в ${NOTIFY_LIMITER.duration / 1000} с: из ${JOBS} отправляется не больше лимита`, async () => {
    for (let i = 0; i < JOBS; i += 1) {
      await sink.notify({
        userId: `9${String(i).padStart(3, "0")}`,
        kind: "throttle_test",
        slotId: `slot-${i}`,
        text: `Уведомление №${i}`,
      });
    }

    // Даём воркеру поработать: лимит должен отсечь лишнее в этом окне.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(NOTIFY_LIMITER.max);
  }, 60_000);

  it("необработанные уведомления остаются в очереди, а не теряются", async () => {
    const counts = await queue.getJobCounts("waiting", "delayed", "active");

    const pending = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
    expect(pending).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(NOTIFY_LIMITER.max);
  }, 30_000);

  it("журнал в NotificationLog заполнен воркером (queued → sent)", async () => {
    const rows = await h.prisma.notificationLog.findMany({ where: { kind: "throttle_test" } });
    expect(rows.length).toBe(sent.length);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(rows.some((r) => r.text.includes("Уведомление №"))).toBe(true);
  }, 30_000);
});
