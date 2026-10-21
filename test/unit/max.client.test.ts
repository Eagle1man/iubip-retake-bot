import { describe, expect, it, beforeAll, vi } from "vitest";

const TOKEN = "max_test_token_secret_9f4a2c_must_not_leak_into_logs";

let lines: string[] = [];
let createRealClient: typeof import("../../src/infra/max/client.js").createRealClient;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgresql://iubip:iubip@localhost:5432/iubip_retake_test";
  process.env.PORT = "3000";
  process.env.MOCK_MAX = "true";

  // Берём реальный createCollectingLogger из src/infra/logger (он импортирует config,
  // поэтому переменные окружения задаём ДО импорта) и подменяем им экспортированный
  // объект logger — клиент, импортированный после патча, получит тот же объект.
  const loggerMod = await import("../../src/infra/logger.js");
  const { logger: collector, lines: collected } = loggerMod.createCollectingLogger();
  lines = collected;
  Object.assign(loggerMod.logger, collector);

  const clientMod = await import("../../src/infra/max/client.js");
  createRealClient = clientMod.createRealClient;
});

function response(status: number) {
  return {
    status,
    ok: status < 400,
    text: async () => "",
    json: async () => ({}),
  };
}

describe("createRealClient (§10: ретраи, таймаут, токены не попадают в лог)", () => {
  it("400 — ретраев нет, один вызов fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(response(400));
    const client = createRealClient({
      token: TOKEN,
      apiBase: "https://platform-api2.max.ru",
      fetch,
    });
    await expect(client.sendMessage("1001", "привет")).rejects.toThrow(
      "MAX отклонил отправку",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("500 — ровно 3 попытки (подменённый fetch)", async () => {
    const fetch = vi.fn().mockResolvedValue(response(500));
    const client = createRealClient({
      token: TOKEN,
      apiBase: "https://platform-api2.max.ru",
      fetch,
    });
    await expect(client.sendMessage("1001", "привет")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("таймаут fetch → исключение", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("AbortSignal timed out"));
    const client = createRealClient({
      token: TOKEN,
      apiBase: "https://platform-api2.max.ru",
      maxRetries: 1,
      fetch,
    });
    await expect(client.sendMessage("1001", "привет")).rejects.toThrow(
      "MAX недоступен",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("в записи лога нет подстроки токена", async () => {
    const fetch = vi.fn().mockResolvedValue(response(500));
    const client = createRealClient({
      token: TOKEN,
      apiBase: "https://platform-api2.max.ru",
      fetch,
    });
    await expect(client.sendMessage("1001", "привет")).rejects.toThrow();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes(TOKEN))).toBe(false);
  });
});

