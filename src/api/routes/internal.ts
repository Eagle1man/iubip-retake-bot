import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { bookingNumber } from "../../domain/staff/role.service.js";
import { saveReceipt } from "../../infra/storage/files.js";
import type { AppContext } from "../context.js";

export const httpStatusFor = (code: string): number => {
  switch (code) {
    case "registration_closed":
      return 410;
    case "duplicate_active":
    case "receipt_used_elsewhere":
    case "cancel_forbidden":
    case "slot_cancelled":
    case "slot_conflict":
      return 409;
    case "booking_not_found":
    case "slot_not_found":
      return 404;
    case "registry_invalid":
      return 400;
    default:
      return 400;
  }
};

const CreateBookingBody = z.object({
  slotId: z.string().min(1),
  studentUserId: z.string().min(1),
  studentFio: z.string().min(3),
  studentGroup: z.string().min(1),
  paymentToken: z.string().optional(),
  amount: z.number().int().positive().optional(),
});

const PaymentBody = z.object({ paid: z.boolean() });
const AttendanceBody = z.object({ attendance: z.enum(["attended", "no_show"]) });
const RoomBody = z.object({ room: z.string().min(1) });

/** Роль для действий, которые выполняет человек. X-User-Id обязателен для оплаты и явки. */
async function requireRole(
  ctx: AppContext,
  request: FastifyRequest,
  roles: ("teacher" | "directorate")[],
): Promise<string | null> {
  const userId = request.headers["x-user-id"];
  if (typeof userId !== "string" || userId === "") return null;

  const resolved = await ctx.prisma.staffRole.findUnique({ where: { userId } });
  const role =
    userId === ctx.config.DIRECTORATE_CHAT_ID
      ? "directorate"
      : resolved?.role === "teacher"
        ? "teacher"
        : resolved?.role === "directorate"
          ? "directorate"
          : null;

  if (!role || !roles.includes(role)) return null;
  return userId;
}

export async function internalRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Все внутренние эндпоинты защищены X-Service-Token (§7 ТЗ).
  await app.register(async (instance) => {
    instance.addHook("preHandler", async (request, reply) => {
      const token = request.headers["x-service-token"];
      if (typeof token !== "string" || !safeToken(token, ctx.config.SERVICE_TOKEN)) {
        return reply.code(401).send({ error: "Неверный X-Service-Token" });
      }
    });

    await internalEndpoints(instance, ctx);
  });
}

function safeToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function internalEndpoints(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Заявленный платёж: подтверждение от сервиса оплаты.
  app.get("/internal/payments/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const booking = await ctx.prisma.booking.findFirst({
      where: { paymentToken: token },
      orderBy: { createdAt: "desc" },
    });

    if (!booking) return reply.code(404).send({ error: "Платёж не найден" });
    return { claimed: true, bookingId: booking.id, number: bookingNumber(booking.seq), status: booking.status };
  });

  // Создание записи, идемпотентно по (paymentToken, slotId).
  app.post("/internal/bookings", async (request, reply) => {
    const body = CreateBookingBody.parse(request.body);
    const result = await ctx.bookings.create(body);

    return reply.code(result.deduplicated ? 200 : 201).send(result);
  });

  app.post("/internal/bookings/:id/receipt", async (request, reply) => {
    const { id } = request.params as { id: string };

    if (request.isMultipart?.()) {
      const part = await request.file();
      if (!part) return reply.code(400).send({ error: "Файл не передан" });
      const buffer = await part.toBuffer();
      if (buffer.byteLength > ctx.config.FILES_MAX_BYTES) {
        return reply.code(413).send({ error: "Файл слишком большой" });
      }
      const { path, hash } = await saveReceipt(buffer, ctx.config.FILES_DIR, id);
      return ctx.bookings.attachReceipt(id, { sha256: hash, path });
    }

    const body = z
      .object({ fileBase64: z.string().min(1), fileName: z.string().optional() })
      .parse(request.body);
    const buffer = Buffer.from(body.fileBase64, "base64");
    if (buffer.byteLength > ctx.config.FILES_MAX_BYTES) {
      return reply.code(413).send({ error: "Файл слишком большой" });
    }
    const { path, hash } = await saveReceipt(buffer, ctx.config.FILES_DIR, id);
    return ctx.bookings.attachReceipt(id, { sha256: hash, path });
  });

  app.post("/internal/bookings/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return ctx.bookings.cancelByStudent(id);
  });

  app.post("/internal/bookings/:id/payment", async (request, reply) => {
    const userId = await requireRole(ctx, request, ["directorate"]);
    if (!userId) return reply.code(403).send({ error: "Только дирекция отмечает оплату" });

    const { id } = request.params as { id: string };
    const body = PaymentBody.parse(request.body);
    return ctx.bookings.setPayment(id, body.paid);
  });

  app.post("/internal/bookings/:id/attendance", async (request, reply) => {
    const userId = await requireRole(ctx, request, ["teacher", "directorate"]);
    if (!userId) return reply.code(403).send({ error: "Явку отмечают преподаватель или дирекция" });

    const { id } = request.params as { id: string };
    const body = AttendanceBody.parse(request.body);
    return ctx.bookings.setAttendance(id, body.attendance);
  });

  app.get("/internal/slots", async (request) => {
    const { disciplineId } = request.query as { disciplineId?: string };
    return ctx.slots.listOpen(disciplineId);
  });

  app.post("/internal/slots/:id/room", async (request) => {
    const { id } = request.params as { id: string };
    const body = RoomBody.parse(request.body);
    return ctx.slots.updateRoom(id, body.room);
  });

  app.post("/internal/slots/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return ctx.slots.cancel(id);
  });

  app.post("/internal/registry/import", async (request, reply) => {
    let csv = "";
    let fileName = "registry.csv";

    if (request.isMultipart?.()) {
      const part = await request.file();
      if (!part) return reply.code(400).send({ error: "Файл не передан" });
      fileName = part.filename || fileName;
      csv = (await part.toBuffer()).toString("utf8");
    } else {
      csv = typeof request.body === "string" ? request.body : String(request.body ?? "");
      if (csv.trim() === "") return reply.code(400).send({ error: "Пустой реестр" });
    }

    const result = await ctx.registry.importCsv(csv, fileName);
    return result;
  });

  app.get("/internal/export/bookings.csv", async (request, reply) => {
    const bookings = await ctx.prisma.booking.findMany({
      include: { slot: { include: { discipline: true, teacher: true } } },
      orderBy: { seq: "asc" },
    });

    const header = [
      "booking_id",
      "student_fio",
      "student_group",
      "discipline",
      "teacher_fio",
      "starts_at",
      "time",
      "room",
      "amount",
      "payment_status",
      "attendance",
      "created_at",
    ];

    const lines = bookings.map((b) => {
      const startsAt = b.slot.startsAt;
      return [
        bookingNumber(b.seq),
        b.studentFio,
        b.studentGroup,
        b.slot.discipline.name,
        b.slot.teacher.fio,
        startsAt.toISOString().slice(0, 10),
        startsAt.toISOString().slice(11, 16),
        b.slot.room,
        String(b.amount),
        b.status,
        b.attendance ?? "",
        b.createdAt.toISOString(),
      ]
        .map(csvCell)
        .join(",");
    });

    // reply — thenable: одна цепочка с return, иначе no-floating-promises
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="bookings.csv"')
      .send([header.join(","), ...lines].join("\n"));
  });
}

/** Экранирование CSV: запятая и кавычки — удвоением. */
function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
