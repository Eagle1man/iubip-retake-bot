import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { logger } from "../../infra/logger.js";
import { listNotifications } from "../../infra/notifications.js";
import { emulatorHtml } from "../../mock-ui/emulator.js";
import type { AppContext } from "../context.js";
import { IncomingEventSchema, type IncomingEvent } from "../../bot/dispatcher.js";

const InjectBody = z.object({
  userId: z.string().min(1),
  text: z.string().optional(),
  callbackData: z.string().optional(),
  file: z
    .object({
      fileId: z.string().optional(),
      url: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
});

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Проверка подписи вебхука MAX. Если секрет не задан — принимаем (mock-режим). */
export function verifyWebhook(request: FastifyRequest, secret: string | undefined): boolean {
  if (!secret) return true;
  const header = request.headers["x-max-signature"];
  if (typeof header !== "string") return false;
  return safeEqual(header, secret);
}

export async function maxRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ── Боевой вебхук ────────────────────────────────────────
  app.post("/internal/webhook/max", async (request, reply) => {
    // Взаимоисключение транспортов (расширенное ТЗ §7): при MODE=polling
    // вебхук не обслуживается вовсе — подписка должна быть настроена под поллер.
    if (ctx.config.MODE === "polling") {
      return reply.code(404).send({ error: "Webhook выключен: MODE=polling" });
    }

    if (!verifyWebhook(request, ctx.config.MAX_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: "Неверная подпись" });
    }

    // Тело проходит через общую схему диспетчера: кривое событие — 400 на входе.
    const parsed = IncomingEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Невалидное событие вебхука",
        details: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }

    // Отвечаем 200 сразу: обработка идёт в фоне, иначе MAX пришлёт событие повторно.
    void ctx
      .dispatch(parsed.data)
      .catch((error) => logger.error("Вебхук MAX не обработан", { error: String(error) }));

    return reply.code(200).send({ ok: true });
  });

  // ── Mock-режим: инъекция входящего события ────────────────
  app.post("/mock/max/inject", async (request, reply) => {
    if (!ctx.config.MOCK_MAX) return reply.code(404).send({ error: "Mock-режим выключен" });

    const body = InjectBody.parse(request.body);
    const event: IncomingEvent = {
      userId: body.userId,
      text: body.text,
      callbackData: body.callbackData,
      file: body.file as IncomingEvent["file"],
    };

    // Тот же диспетчер, что и у настоящего вебхука (§8 ТЗ).
    await ctx.dispatch(event);
    return { accepted: true };
  });

  app.get("/mock/history", async (request, reply) => {
    if (!ctx.config.MOCK_MAX) return reply.code(404).send({ error: "Mock-режим выключен" });

    const { userId } = request.query as { userId?: string };
    if (!userId) return reply.code(400).send({ error: "userId обязателен" });

    const since = new Date(Date.now() - 24 * 3_600_000);
    const rows = await listNotifications(ctx.prisma, userId, since);
    return {
      userId,
      messages: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        text: row.text,
        status: row.status,
        // Без keyboard у эмулятора не из чего рисовать кнопки — §12 состоит из нажатий.
        keyboard: row.keyboard ?? null,
        at: row.createdAt.toISOString(),
      })),
    };
  });

  // ── Эмулятор чата ────────────────────────────────────────
  app.get("/mock/", async (_request, reply) => {
    if (!ctx.config.MOCK_MAX) return reply.code(404).send({ error: "Mock-режим выключен" });

    // reply — thenable: цепочка с return, иначе no-floating-promises
    const html = await emulatorHtml();
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
