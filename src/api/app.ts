import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { BookingError } from "../domain/booking/booking.rules.js";
import { logger } from "../infra/logger.js";
import type { AppContext } from "./context.js";
import { healthRoutes } from "./routes/health.js";
import { internalRoutes, httpStatusFor } from "./routes/internal.js";
import { maxRoutes } from "./routes/max.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: ctx.config.FILES_MAX_BYTES + 1024 * 1024,
  });

  await app.register(multipart, { limits: { fileSize: ctx.config.FILES_MAX_BYTES } });

  // Реестр бухгалтерии приходит обычным text/csv, а не JSON.
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  // POST без данных часто отправляют с content-type: application/json и пустым телом.
  // Форсировать на таком вызове ошибку 400 — лишний отказ: тело эндпоинту не нужно.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const raw = typeof body === "string" ? body.trim() : "";
      if (raw === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (error) {
        const parseError = error as Error & { statusCode?: number };
        parseError.statusCode = 400;
        done(parseError, undefined);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Невалидное тело",
        details: error.issues.map((issue) => issue.message),
      });
    }
    if (error instanceof BookingError) {
      return reply.code(httpStatusFor(error.code)).send({ error: error.message, code: error.code });
    }
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    logger.error("Необработанная ошибка", { url: request.url, error: error.message });
    return reply.code(500).send({ error: "Внутренняя ошибка" });
  });

  await healthRoutes(app, ctx);
  await maxRoutes(app, ctx);
  await internalRoutes(app, ctx);

  return app;
}
