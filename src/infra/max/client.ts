import { logger } from "../logger.js";
import type { MaxClient, MaxKeyboard } from "./types.js";

const TIMEOUT_MS = 10_000;

/**
 * Тонкий клиент MAX на fetch (§3 ТЗ): SDK не тянем ради двух методов.
 * Ретраим только 5xx и сетевые ошибки; 4xx — ответ как есть, без ретрая.
 */
export function createRealClient(config: {
  token: string;
  apiBase: string;
  maxRetries?: number;
  fetch?: typeof fetch;
}): MaxClient {
  const doFetch = config.fetch ?? fetch;
  const maxRetries = config.maxRetries ?? 3;

  async function request(path: string, body: unknown): Promise<Response> {
    let lastError: unknown;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      try {
        const response = await doFetch(`${config.apiBase}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        // 4xx — это ответ MAX, а не сбой связи: ретраить бессмысленно.
        if (response.status < 500) return response;

        lastError = new Error(`MAX ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt >= maxRetries) break;
      const delay = 1000 * 2 ** (attempt - 1);
      logger.warn("MAX ответ требует повтора", { attempt, delay, path });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Единое сообщение об отказе: оператору видно, что упало на связи,
    // а в лог не попадает ни токен, ни тело запроса.
    const detail = lastError instanceof Error ? lastError.message : "";
    throw new Error(detail ? `MAX недоступен: ${detail}` : "MAX недоступен", { cause: lastError });
  }

  return {
    async sendMessage(userId: string, text: string, keyboard?: MaxKeyboard, _kind?: string) {
      const response = await request("/messages", { chatId: userId, text, keyboard });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`MAX отклонил отправку: ${response.status} ${body.slice(0, 200)}`);
      }
      const data = (await response.json().catch(() => ({}))) as { messageId?: string };
      return { messageId: data.messageId ?? "unknown" };
    },
  };
}
