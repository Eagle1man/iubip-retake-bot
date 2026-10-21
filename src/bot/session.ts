import type { Prisma, PrismaClient } from "@prisma/client";

export type BotState =
  | "IDLE"
  | "AWAIT_DISCIPLINE"
  | "AWAIT_SLOT"
  | "AWAIT_FIO"
  | "AWAIT_GROUP"
  | "AWAIT_CONFIRM"
  | "AWAIT_RECEIPT_OR_SKIP"
  | "AWAIT_RECEIPT_FILE"
  | "AWAIT_ROOM"
  | "AWAIT_REGISTRY_FILE"
  | "AWAIT_PAYMENT_TARGET"
  | "AWAIT_PAYMENT_CONFIRM"
  | "AWAIT_SLOT_TARGET"
  | "AWAIT_SLOT_TEACHER"
  | "AWAIT_SLOT_DISCIPLINE"
  | "AWAIT_SLOT_STARTS_AT"
  | "AWAIT_SLOT_ROOM";

export interface SessionData {
  disciplineId?: string | undefined;
  disciplineName?: string | undefined;
  slotId?: string | undefined;
  slotLabel?: string | undefined;
  bookingId?: string | undefined;
  teacherId?: string | undefined;
  slotDisciplineId?: string | undefined;
  slotStartsAt?: string | undefined;
  paymentBookingId?: string | undefined;
  fio?: string | undefined;
  group?: string | undefined;
  payloadToken?: string | undefined;
}

export interface BotSessionState {
  state: BotState;
  data: SessionData;
}

const EMPTY: BotSessionState = { state: "IDLE", data: {} };

export class BotSessionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async get(userId: string): Promise<BotSessionState> {
    const row = await this.prisma.botSession.findUnique({ where: { userId } });
    if (!row) return { state: "IDLE", data: {} };
    const data = (row.data ?? {}) as SessionData;
    return { state: row.state as BotState, data };
  }

  async set(userId: string, state: BotState, data: SessionData): Promise<void> {
    // JSON-поле не принимает undefined: убираем пустые ключи сериализацией.
    const json = JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
    await this.prisma.botSession.upsert({
      where: { userId },
      create: { userId, state, data: json },
      update: { state, data: json },
    });
  }

  async reset(userId: string): Promise<void> {
    await this.set(userId, "IDLE", {});
  }
}

export const initialState = (): BotSessionState => ({ ...EMPTY, data: { ...EMPTY.data } });
