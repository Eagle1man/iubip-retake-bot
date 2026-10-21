import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config.js";
import type { BookingService, NotificationSink } from "../domain/booking/booking.service.js";
import type { RegistryService } from "../domain/registry/registry.service.js";
import type { SlotService } from "../domain/slot/slot.service.js";
import type { MaxClient } from "../infra/max/types.js";
import type { BotSessionStore } from "../bot/session.js";
import type { IncomingEvent } from "../bot/dispatcher.js";

/** Всё, что нужно роутам. Собирается один раз в index.ts. */
export interface AppContext {
  prisma: PrismaClient;
  config: AppConfig;
  /** ping для /healthz. */
  pingRedis: () => Promise<unknown>;
  bookings: BookingService;
  slots: SlotService;
  registry: RegistryService;
  client: MaxClient;
  sessions: BotSessionStore;
  notifications: NotificationSink;
  /** Диспетчер бота с уже привязанными зависимостями. */
  dispatch: (event: IncomingEvent) => Promise<void>;
}
