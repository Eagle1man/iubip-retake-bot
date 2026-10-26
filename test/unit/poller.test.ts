import { describe, expect, it, vi } from "vitest";
import { startPoller } from "../../src/infra/max/poller.js";
import type { IncomingEvent } from "../../src/bot/dispatcher.js";

/**
 * MODE=polling (расширенное ТЗ §3, этап 1.5) и взаимоисключение с webhook (§7).
 * Сеть нет: fetch подменяется, токен — фиктивный.
 */

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: условие не наступило");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("MODE=polling: long polling (этап 1.5)", () => {
  it("взаимоисключение: MODE=webhook → поллер не создаётся (null), цикла нет", () => {
    const handle = startPoller({
      mode: "webhook",
      apiBase: "http://max.test",
      token: "tok",
      onEvent: async () => undefined,
    });

    expect(handle).toBeNull();
  });

  it("MODE=polling без токена → понятная ошибка, а не 401 в цикле", () => {
    expect(() =>
      startPoller({
        mode: "polling",
        apiBase: "http://max.test",
        onEvent: async () => undefined,
      }),
    ).toThrow("MAX_BOT_TOKEN обязателен");
  });

  it("события уходят в onEvent, невалидные отсеиваются, offset обновляется", async () => {
    const received: IncomingEvent[] = [];
    const fetchMock = vi
      .fn()
      // Первый ответ: одно валидное событие и одно без userId.
      .mockResolvedValueOnce(
        jsonResponse({
          updates: [
            { userId: "1001", text: "/start" },
            { userId: "", text: "кривое" },
            { nonsense: true },
          ],
          nextOffset: 7,
        }),
      )
      // Дальше — «вечный» long poll, который прерывается только stop().
      .mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted")), {
              once: true,
            });
          }),
      );

    const handle = startPoller({
      mode: "polling",
      apiBase: "http://max.test",
      token: "tok-123",
      onEvent: async (event) => {
        received.push(event);
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(handle).not.toBeNull();
    await waitUntil(() => received.length > 0);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ userId: "1001", text: "/start" });
    expect(handle?.offset()).toBe(7);

    // Контракт запроса: путь, метод, заголовок авторизации.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("http://max.test/updates?timeout=30&offset=0");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok-123");

    await handle?.stop();
  }, 15_000);

  it("после stop() новые события не обрабатываются", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve, reject) => {
          calls += 1;
          if (calls === 1) {
            resolve(jsonResponse({ updates: [{ userId: "1", text: "первое" }], nextOffset: 1 }));
          } else {
            reject(new DOMException("aborted"));
          }
        }),
    );

    const received: IncomingEvent[] = [];
    const handle = startPoller({
      mode: "polling",
      apiBase: "http://max.test",
      token: "tok",
      onEvent: async (event) => {
        received.push(event);
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await waitUntil(() => received.length > 0);
    await handle?.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
  }, 15_000);
});
