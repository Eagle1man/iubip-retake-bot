import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHarness, type Harness } from "../helpers/harness.js";
import { createRealClient } from "../../src/infra/max/client.js";

/**
 * Контракт транспорта MAX без реального MAX (расширенное ТЗ §5.3):
 * локальная заглушка HTTP на :19090 принимает исходящие запросы — проверяем
 * URL/путь, метод, заголовок авторизации и тело. Входящие события проверяются
 * через вебхук: валидация общей схемой и взаимоисключение webhook/polling.
 */

const STUB_PORT = 19090;

interface Captured {
  method: string;
  url: string;
  authorization?: string | undefined;
  body: Record<string, unknown>;
}

let server: Server;
const captured: Captured[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = { raw };
      }
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });

      if (body.text === "FAIL_400") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rejected" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messageId: "m-stub-1" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(STUB_PORT, "127.0.0.1", resolve));
  captured.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("исходящие запросы к MAX API (стаб :19090)", () => {
  it("sendMessage уходит на /messages POST с Bearer-токеном и телом {chatId, text, keyboard}", async () => {
    const client = createRealClient({ token: "stub-token", apiBase: `http://127.0.0.1:${STUB_PORT}` });

    const result = await client.sendMessage(
      "1001",
      "Привет из контрактного теста",
      { buttons: [[{ text: "Ок", callbackData: "yes" }]] },
      "contract_test",
    );

    expect(result.messageId).toBe("m-stub-1");

    const call = captured.at(-1);
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("/messages");
    expect(call?.authorization).toBe("Bearer stub-token");
    expect(call?.body).toMatchObject({
      chatId: "1001",
      text: "Привет из контрактного теста",
      keyboard: { buttons: [[{ text: "Ок", callbackData: "yes" }]] },
    });
  });

  it("4xx от MAX не ретраится: ровно один запрос и понятная ошибка", async () => {
    const client = createRealClient({
      token: "stub-token",
      apiBase: `http://127.0.0.1:${STUB_PORT}`,
      maxRetries: 3,
    });

    const before = captured.filter((c) => c.body.text === "FAIL_400").length;
    await expect(client.sendMessage("1001", "FAIL_400")).rejects.toThrow("MAX отклонил отправку: 400");

    const attempts = captured.filter((c) => c.body.text === "FAIL_400").length;
    expect(attempts - before).toBe(1);
  });
});

describe("входящие события: вебхук (общая схема диспетчера)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  const signature = () => ({
    "content-type": "application/json",
    "x-max-signature": h.config.MAX_WEBHOOK_SECRET ?? "",
  });

  it("валидное событие → 200 {ok:true} и уходит в диспетчер", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/webhook/max",
      headers: signature(),
      payload: { userId: "1001", text: "/start" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("невалидное тело (нет userId) → 400, а не падение в диспетчере", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/webhook/max",
      headers: signature(),
      payload: { text: "/start" },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Невалидное событие");
  });

  it("взаимоисключение: при MODE=polling вебхук выключен (404)", async () => {
    const pollingHarness = await createHarness({ MODE: "polling" });

    const res = await pollingHarness.app.inject({
      method: "POST",
      url: "/internal/webhook/max",
      headers: { "content-type": "application/json" },
      payload: { userId: "1001", text: "/start" },
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain("MODE=polling");

    await pollingHarness.close();
  });
});
