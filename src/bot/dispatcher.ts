import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { BookingService, type NotificationSink } from "../domain/booking/booking.service.js";
import { RegistryService } from "../domain/registry/registry.service.js";
import { RoleService, type Role } from "../domain/staff/role.service.js";
import { SlotService } from "../domain/slot/slot.service.js";
import type { MaxClient, MaxKeyboard } from "../infra/max/types.js";
import { BotSessionStore, type BotSessionState } from "./session.js";

export interface Deps {
  prisma: PrismaClient;
  config: AppConfig;
  sessions: BotSessionStore;
  roles: RoleService;
  bookings: BookingService;
  slots: SlotService;
  registry: RegistryService;
  client: MaxClient;
  notifications: NotificationSink;
}

export interface IncomingEvent {
  userId: string;
  text?: string | undefined;
  callbackData?: string | undefined;
  file?: { fileId?: string | undefined; url?: string | undefined; name?: string | undefined } | undefined;
}

/**
 * Схема входящего события (расширенное ТЗ §5.3): и боевой вебхук, и long
 * polling проверяют тело ОДНОЙ схемой — кривое событие отваливается на входе,
 * а не падает в диспетчере посреди обработки.
 */
export const IncomingEventSchema = z.object({
  userId: z.string().min(1, "userId обязателен"),
  text: z.string().optional(),
  callbackData: z.string().optional(),
  file: z
    .object({
      fileId: z.string().optional(),
      url: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
});

export type IncomingEventParsed = z.infer<typeof IncomingEventSchema>;

export interface BotContext {
  event: IncomingEvent;
  role: Role;
  session: BotSessionState;
  deps: Deps;
  send: (text: string, keyboard?: MaxKeyboard) => Promise<void>;
}

export type Handler = (ctx: BotContext) => Promise<void>;

export function createContext(
  event: IncomingEvent,
  role: Role,
  session: BotSessionState,
  deps: Deps,
): BotContext {
  return {
    event,
    role,
    session,
    deps,
    send: async (text, keyboard) => {
      await deps.client.sendMessage(event.userId, text, keyboard);
    },
  };
}

/** Детерминированный токен платежа: повтор запроса не создаёт дубль записи. */
export function paymentTokenFor(userId: string, slotId: string): string {
  return `pay_${userId}_${slotId}`;
}

export { BotSessionStore };
