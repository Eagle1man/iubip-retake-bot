import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, resetDb, type Harness } from "../helpers/harness.js";

let h: Harness;
let mockOff: Harness;

beforeAll(async () => {
  h = await createHarness();
  mockOff = await createHarness({ MOCK_MAX: false });
  await resetDb(h.prisma);
});

afterAll(async () => {
  await mockOff.close();
  await h.close();
});

describe("GET /healthz (§7: db, redis, mockMax)", () => {
  it("возвращает 200 и состояние компонентов", async () => {
    const res = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ db: "ok", redis: "ok", mockMax: true });
  });

  it("падение redis не роняет healthz — остаётся 200, redis: fail", async () => {
    const { buildApp } = await import("../../src/api/app.js");
    const app = await buildApp({ ...h.ctx, pingRedis: async () => Promise.reject(new Error("redis down")) });

    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ db: "ok", redis: "fail" });
    await app.close();
  });
});

describe("аутентификация внутреннего API (§7)", () => {
  it("без X-Service-Token → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/bookings",
      payload: { slotId: "x", studentUserId: "1", studentFio: "Иванов Иван Иванович", studentGroup: "ГР-1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("с неверным токеном → 401", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/internal/slots",
      headers: { "X-Service-Token": "wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("с верным токеном → 200", async () => {
    const res = await h.app.inject({ method: "GET", url: "/internal/slots", headers: h.headers });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe("вебхук MAX", () => {
  it("неверная подпись → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/webhook/max",
      headers: { "x-max-signature": "not-the-secret" },
      payload: { userId: "1001", text: "/start" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("без заголовка подписи → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/webhook/max",
      payload: { userId: "1001", text: "/start" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("верная подпись → 200, событие уходит в тот же диспетчер", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/webhook/max",
      headers: { "x-max-signature": h.config.MAX_WEBHOOK_SECRET as string },
      payload: { userId: "1001", text: "/start" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("mock-инъекция (§8: работает только при MOCK_MAX=true)", () => {
  it("при MOCK_MAX=true событие принимается", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/mock/max/inject",
      payload: { userId: "1001", text: "/start" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: true });
  });

  it("при MOCK_MAX=false → 404", async () => {
    const res = await mockOff.app.inject({
      method: "POST",
      url: "/mock/max/inject",
      payload: { userId: "1001", text: "/start" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("история при MOCK_MAX=false → 404", async () => {
    const res = await mockOff.app.inject({
      method: "GET",
      url: "/mock/history?userId=1001",
    });
    expect(res.statusCode).toBe(404);
  });

  it("страница эмулятора при MOCK_MAX=false → 404", async () => {
    const res = await mockOff.app.inject({ method: "GET", url: "/mock/" });
    expect(res.statusCode).toBe(404);
  });

  it("страница эмулятора при MOCK_MAX=true отдаёт HTML (§8)", async () => {
    const res = await h.app.inject({ method: "GET", url: "/mock/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("MAX");
  });

  it("/mock/history без userId → 400", async () => {
    const res = await h.app.inject({ method: "GET", url: "/mock/history" });
    expect(res.statusCode).toBe(400);
  });
});

describe("невалидное тело → 400, а не 500", () => {
  it("POST /internal/bookings без обязательных полей", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/internal/bookings",
      headers: h.headers,
      payload: { slotId: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("details");
  });
});
