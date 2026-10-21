import { config } from "./config.js";
import { logger } from "./infra/logger.js";
import { disconnectPrisma, getPrisma } from "./infra/db/prisma.js";
import { createMaxClient } from "./infra/max/index.js";
import { closeQueue, createNotifyQueue, QueueNotificationSink, getRedis } from "./infra/queue/queue.js";
import { closeWorker, createNotifyWorker } from "./infra/queue/worker.js";
import { BookingService } from "./domain/booking/booking.service.js";
import { SlotService } from "./domain/slot/slot.service.js";
import { RegistryService } from "./domain/registry/registry.service.js";
import { RoleService } from "./domain/staff/role.service.js";
import { BotSessionStore } from "./bot/session.js";
import { dispatch as dispatchBot } from "./bot/dispatch.js";
import type { Deps } from "./bot/dispatcher.js";
import { buildApp } from "./api/app.js";
import type { AppContext } from "./api/context.js";

async function main(): Promise<void> {
  const prisma = getPrisma();
  const redis = getRedis(config.REDIS_URL);
  const client = createMaxClient(prisma);
  const queue = createNotifyQueue(config.REDIS_URL);
  const notifications = new QueueNotificationSink(queue, getRedis(config.REDIS_URL));

  const roles = new RoleService(prisma, config.DIRECTORATE_CHAT_ID);
  const bookings = new BookingService(
    prisma,
    notifications,
    config.CANCEL_DEADLINE_HOURS,
    config.DIRECTORATE_CHAT_ID,
  );
  const slots = new SlotService(prisma, notifications);
  const registry = new RegistryService(prisma, notifications);
  const sessions = new BotSessionStore(prisma);

  const deps: Deps = {
    prisma,
    config,
    sessions,
    roles,
    bookings,
    slots,
    registry,
    client,
    notifications,
  };

  const appContext: AppContext = {
    prisma,
    config,
    pingRedis: async () => await redis.ping(),
    bookings,
    slots,
    registry,
    client,
    sessions,
    notifications,
    dispatch: (event) => dispatchBot(event, deps),
  };

  const worker = createNotifyWorker({
    prisma,
    client,
    redisUrl: config.REDIS_URL,
    clientWritesLog: config.MOCK_MAX,
  });

  const app = await buildApp(appContext);
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info("Сервис запущен", { port: config.PORT, mockMax: config.MOCK_MAX });

  const shutdown = async () => {
    logger.info("Остановка…");
    await app.close();
    await closeWorker(worker);
    await closeQueue(queue, redis).catch(() => undefined);
    await disconnectPrisma();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  logger.fatal("Не удалось запустить сервис", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
