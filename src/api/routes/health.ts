import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/healthz", async () => {
    let db: "ok" | "fail" = "ok";
    let redis: "ok" | "fail" = "ok";

    try {
      await ctx.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = "fail";
    }

    try {
      await ctx.pingRedis();
    } catch {
      redis = "fail";
    }

    return { db, redis, mockMax: ctx.config.MOCK_MAX };
  });
}
