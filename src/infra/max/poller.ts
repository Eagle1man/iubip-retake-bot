import { logger } from "../logger.js";
import { IncomingEventSchema, type IncomingEvent } from "../../bot/dispatcher.js";

/**
 * Long polling MAX (расширенное ТЗ §3, этап 1.5).
 *
 * Назначение — ручная проверка в реальном чате, когда есть токен, но ещё нет
 * публичного IP. Production-транспорт — webhook (этап 2): при MODE=webhook
 * поллер не создаётся вовсе (взаимоисключение в startPoller).
 *
 * Допущение: форма ответа `{ updates: [...], nextOffset }`, событие — плоский
 * объект вида `{ userId, text?, callbackData?, file? }` (наша схема
 * IncomingEvent). Фактический формат MAX уточняется по документации площадки
 * на этапе 1.5 (см. DECISIONS.md §5) — меняется только разбор ответа здесь.
 */

export interface PollerOptions {
  mode: "webhook" | "polling";
  apiBase: string;
  token?: string | undefined;
  onEvent: (event: IncomingEvent) => Promise<void>;
  /** Серверный long-poll timeout, сек. */
  timeoutSec?: number;
  fetch?: typeof fetch;
}

export interface PollerHandle {
  /** Остановить цикл и оборвать текущий запрос. */
  stop(): Promise<void>;
  /** Текущий offset — для диагностики. */
  offset(): number;
}

const BACKOFF_MS = 2_000;

/**
 * Запуск транспорта по режиму. Единственная точка взаимоисключения:
 * mode=webhook → null (поллер не создаётся, цикла нет), mode=polling → цикл.
 */
export function startPoller(options: PollerOptions): PollerHandle | null {
  // Взаимоисключение: webhook → поллер не создаётся, polling → цикл.
  if (options.mode !== "polling") return null;

  if (!options.token) {
    throw new Error("MAX_BOT_TOKEN обязателен, когда MODE=polling");
  }

  const doFetch = options.fetch ?? fetch;
  const timeoutSec = options.timeoutSec ?? 30;
  const controller = new AbortController();
  let currentOffset = 0;
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const response = await doFetch(
          `${options.apiBase}/updates?timeout=${timeoutSec}&offset=${currentOffset}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${options.token}` },
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout((timeoutSec + 15) * 1000),
            ]),
          },
        );

        if (!response.ok) {
          // 4xx — постоянный отказ (токен/путь), 5xx — временный: в обоих
          // случаях ждём и опрашиваем дальше, но лог виден оператору.
          logger.warn("MAX polling: негативный ответ", { status: response.status });
          await sleep(BACKOFF_MS, controller.signal);
          continue;
        }

        const body = (await response.json().catch(() => ({}))) as {
          updates?: unknown[];
          nextOffset?: number;
        };
        const updates = Array.isArray(body.updates) ? body.updates : [];

        for (const raw of updates) {
          const parsed = IncomingEventSchema.safeParse(raw);
          if (!parsed.success) {
            logger.warn("MAX polling: событие не прошло схему", {
              details: parsed.error.issues.map((issue) => issue.message).join("; "),
            });
            continue;
          }
          await options.onEvent(parsed.data);
        }

        if (typeof body.nextOffset === "number") {
          currentOffset = body.nextOffset;
        } else {
          currentOffset += updates.length;
        }
      } catch (error) {
        if (stopped) return;
        logger.warn("MAX polling: сбой запроса", { error: error instanceof Error ? error.message : String(error) });
        await sleep(BACKOFF_MS, controller.signal);
      }
    }
  };

  void loop().catch((error) => {
    logger.error("MAX polling: цикл завершён с ошибкой", { error: String(error) });
  });

  return {
    async stop() {
      stopped = true;
      controller.abort();
      // Даём циклу выйти из зависшего запроса.
      await sleep(0);
    },
    offset: () => currentOffset,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
