import type { PrismaClient } from "@prisma/client";
import { logger } from "../logger.js";
import { recordNotification } from "../notifications.js";
import type { MaxClient, MaxKeyboard } from "./types.js";

/**
 * Mock-клиент MAX: ничего не отправляет в сеть, пишет в NotificationLog со статусом sent.
 * Используется при MOCK_MAX=true (§8 ТЗ). В остальном интерфейс тот же, что у боевого.
 */
export function createMockClient(prisma: PrismaClient): MaxClient {
  return {
    async sendMessage(userId: string, text: string, keyboard?: MaxKeyboard, kind?: string) {
      const id = await recordNotification(
        prisma,
        {
          userId,
          // Бот отвечает без вида уведомления, очередь — с ним: журнал показывает
          // и «что ушло в канал», и «по какому событию» (§11.3 шаг 8).
          kind: kind ?? "outgoing",
          text,
          status: "sent",
        },
        keyboard,
      );
      logger.info("[mock-max] -> " + userId, { text: text.slice(0, 120), logId: id });
      return { messageId: id };
    },
  };
}
