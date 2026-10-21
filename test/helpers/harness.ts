import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../../src/config.js";
import type { AppContext } from "../../src/api/context.js";
import { buildApp } from "../../src/api/app.js";
import { BookingService, type Notification, type NotificationSink } from "../../src/domain/booking/booking.service.js";
import { RegistryService } from "../../src/domain/registry/registry.service.js";
import { RoleService } from "../../src/domain/staff/role.service.js";
import { SlotService } from "../../src/domain/slot/slot.service.js";
import { BotSessionStore } from "../../src/bot/session.js";
import type { Deps } from "../../src/bot/dispatcher.js";
import { dispatch as runDispatch } from "../../src/bot/dispatch.js";
import { createMockClient } from "../../src/infra/max/mock-client.js";
import type { MaxClient, MaxKeyboard } from "../../src/infra/max/types.js";
import { TEST_DATABASE_URL } from "../setup/global.js";

/** Уведомления идут напрямую в клиент без очереди: Redis для основной части тестов не нужен. */
export class DirectSink implements NotificationSink {
  constructor(private readonly client: MaxClient) {}

  async notify(notification: Notification): Promise<void> {
    if (!notification.userId) return;
    // Тот же вызов, что делает воркер: kind обязателен, чтобы журнал различал события.
    await this.client.sendMessage(notification.userId, notification.text, undefined, notification.kind);
  }
}

export class RecordingClient implements MaxClient {
  readonly sent: { userId: string; text: string; keyboard?: MaxKeyboard }[] = [];

  constructor(private readonly inner: MaxClient) {}

  async sendMessage(userId: string, text: string, keyboard?: MaxKeyboard, kind?: string) {
    this.sent.push({ userId, text, ...(keyboard ? { keyboard } : {}) });
    return this.inner.sendMessage(userId, text, keyboard, kind);
  }

  lastFor(userId: string) {
    return [...this.sent].reverse().find((m) => m.userId === userId);
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export interface Harness {
  app: FastifyInstance;
  prisma: PrismaClient;
  client: RecordingClient;
  sink: DirectSink;
  headers: Record<string, string>;
  config: AppConfig;
  /** Тот же контекст, что у продакшн-сборки: нужен, чтобы собрать второй app с подменой. */
  ctx: AppContext;
  dispatch: (event: Parameters<typeof runDispatch>[0]) => Promise<void>;
  close: () => Promise<void>;
}

const baseHeaders = (token: string): Record<string, string> => ({
  "content-type": "application/json",
  "X-Service-Token": token,
});

export async function createHarness(overrides?: Partial<AppConfig>): Promise<Harness> {
  const { config } = await import("../../src/config.js");

  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  await prisma.$connect();

  const effective = overrides ? { ...config, ...overrides } : config;
  const client = new RecordingClient(createMockClient(prisma));
  const sink = new DirectSink(client);
  const roles = new RoleService(prisma, effective.DIRECTORATE_CHAT_ID);
  const bookings = new BookingService(
    prisma,
    sink,
    effective.CANCEL_DEADLINE_HOURS,
    effective.DIRECTORATE_CHAT_ID,
  );
  const slots = new SlotService(prisma, sink);
  const registry = new RegistryService(prisma, sink);
  const sessions = new BotSessionStore(prisma);

  const deps: Deps = {
    prisma,
    config: effective,
    sessions,
    roles,
    bookings,
    slots,
    registry,
    client,
    notifications: sink,
  };

  const ctx: AppContext = {
    prisma,
    config: effective,
    pingRedis: async () => "PONG",
    bookings,
    slots,
    registry,
    client,
    sessions,
    notifications: sink,
    dispatch: (event) => runDispatch(event, deps),
  };

  const app = await buildApp(ctx);

  return {
    app,
    prisma,
    client,
    sink,
    headers: baseHeaders(effective.SERVICE_TOKEN),
    config: effective,
    ctx,
    dispatch: (event) => runDispatch(event, deps),
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

/** Очистка тестовой базы: каждый файл начинает с чистого состояния. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "NotificationLog", "RegistryRow", "RegistryImport", "BotSession", "Booking", "ExamSlot", "Discipline", "Teacher", "StaffRole" CASCADE`,
  );
}

/** Последнее сообщение бота пользователю вместе с его кнопками. */
export async function lastBotMessage(prisma: PrismaClient, userId: string) {
  const rows = await prisma.notificationLog.findMany({
    where: { userId, kind: "outgoing" },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const row = rows[0];
  if (!row) return null;
  return {
    text: row.text,
    keyboard: (row.keyboard as { buttons: { text: string; callbackData: string }[][] } | null) ?? null,
  };
}

/** Ответ бота содержит кнопку с этим callbackData. */
export async function findCallback(
  prisma: PrismaClient,
  userId: string,
  callbackData: string,
): Promise<string | null> {
  const last = await lastBotMessage(prisma, userId);
  if (!last?.keyboard) return null;
  for (const line of last.keyboard.buttons) {
    for (const button of line) {
      if (button.callbackData === callbackData || button.callbackData.startsWith(callbackData)) {
        return button.callbackData;
      }
    }
  }
  return null;
}
