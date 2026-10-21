import type { PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { createRealClient } from "./client.js";
import { createMockClient } from "./mock-client.js";
import type { MaxClient } from "./types.js";

/**
 * Переключение mock/real — в одном месте (§13.17).
 * Обработчики бота не знают, какой клиент под ними.
 */
export function createMaxClient(prisma: PrismaClient): MaxClient {
  if (config.MOCK_MAX) return createMockClient(prisma);

  if (!config.MAX_BOT_TOKEN) {
    throw new Error("MAX_BOT_TOKEN обязателен, когда MOCK_MAX=false");
  }

  return createRealClient({
    token: config.MAX_BOT_TOKEN,
    apiBase: config.MAX_API_BASE,
  });
}
