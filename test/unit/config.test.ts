import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://iubip:iubip@localhost:5432/iubip_retake_test",
    PORT: "3000",
    LOG_LEVEL: "info",
    REDIS_URL: "redis://localhost:6379",
    MOCK_MAX: "true",
    MAX_BOT_TOKEN: "test-bot-token",
    SERVICE_TOKEN: "dev-service-token",
  };
}

beforeEach(() => setEnv(baseEnv()));
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** config.ts оценивает окружение при импорта модуля — сбрасываем кэш и импортируем заново. */
async function loadConfig() {
  vi.resetModules();
  const mod = await import("../../src/config.js");
  return mod.config;
}

describe("config", () => {
  it("MOCK_MAX='false' разбирается в false — не ловушка z.coerce.boolean()", async () => {
    setEnv({ MOCK_MAX: "false" });
    const config = await loadConfig();
    expect(config.MOCK_MAX).toBe(false);
    expect(typeof config.MOCK_MAX).toBe("boolean");
  });

  it("MOCK_MAX=false без MAX_BOT_TOKEN → throw «MAX_BOT_TOKEN обязателен…»", async () => {
    setEnv({ MOCK_MAX: "false" });
    delete process.env.MAX_BOT_TOKEN;
    await expect(loadConfig()).rejects.toThrow("MAX_BOT_TOKEN обязателен");
  });

  it("MOCK_MAX=false без MAX_WEBHOOK_SECRET → throw (иначе вебхук не защищён)", async () => {
    // Пустая строка, а не удаление переменной: .env подгрузит значение заново.
    setEnv({ MOCK_MAX: "false", MAX_BOT_TOKEN: "test-bot-token", MAX_WEBHOOK_SECRET: "" });
    await expect(loadConfig()).rejects.toThrow("MAX_WEBHOOK_SECRET обязателен");
  });

  it("пустой SERVICE_TOKEN → throw (внутренний API не должен открываться по умолчанию)", async () => {
    setEnv({ SERVICE_TOKEN: "" });
    await expect(loadConfig()).rejects.toThrow("SERVICE_TOKEN обязателен");
  });

  it("нечисловой PORT → throw", async () => {
    setEnv({ PORT: "not-a-number" });
    await expect(loadConfig()).rejects.toThrow(/Невалидное окружение/);
  });

  it("валидное окружение парсится без ошибок", async () => {
    const config = await loadConfig();
    expect(config.MOCK_MAX).toBe(true);
    expect(config.PORT).toBe(3000);
    expect(config.DATABASE_URL).toContain("localhost:5432");
  });
});
