import type { PrismaClient } from "@prisma/client";
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
