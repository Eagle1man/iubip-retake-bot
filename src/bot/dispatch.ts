import { BookingError } from "../domain/booking/booking.rules.js";
import { bookingNumber } from "../domain/staff/role.service.js";
import { saveReceipt } from "../infra/storage/files.js";
import { createContext, type BotContext, type Deps, type IncomingEvent } from "./dispatcher.js";
import * as directorate from "./handlers/directorate.js";
import { handleStart } from "./handlers/start.js";
import * as student from "./handlers/student.js";
import * as teacher from "./handlers/teacher.js";
import { texts } from "./texts.js";

/**
 * Единая точка входа бота. Вызывается и из вебхука MAX, и из mock-инъекции,
 * поэтому mock и боевой режим идут одним кодом (§8 ТЗ).
 */
export async function dispatch(event: IncomingEvent, deps: Deps): Promise<void> {
  const role = await deps.roles.resolve(event.userId);
  const session = await deps.sessions.get(event.userId);
  const ctx = createContext(event, role, session, deps);

  try {
    if (event.callbackData) await routeCallback(ctx, event.callbackData);
    else if (event.file) await routeFile(ctx);
    else await routeText(ctx, event.text ?? "");
  } catch (error) {
    // Сбой одного события не должен ронять воркер очереди.
    if (error instanceof BookingError) {
      await ctx.send(texts.system.error);
      return;
    }
    throw error;
  }
}

async function routeCallback(ctx: BotContext, data: string): Promise<void> {
  const [head, ...rest] = data.split(":");
  const arg = rest.join(":");

  // ── Студент ───────────────────────────────────────────────
  switch (head) {
    case "d":
      return student.handleDiscipline(ctx, arg);
    case "s":
      return student.handleSlot(ctx, arg);
    case "yes":
      return student.handleConfirm(ctx);
    case "restart":
      return student.listOpenSlots(ctx);
    case "attach_receipt":
      return student.handleReceiptPrompt(ctx);
    case "skip_receipt":
      return student.handleReceiptSkip(ctx);
    case "cancel":
      return student.handleCancel(ctx, arg);
  }

  // ── Преподаватель ─────────────────────────────────────────
  if (ctx.role === "teacher") {
    switch (head) {
      case "my_slots":
        return teacher.handleMySlots(ctx);
      case "create_slot":
        return teacher.handleCreateSlot(ctx);
      case "booked":
        return teacher.handleBookedList(ctx, arg);
      case "close":
        return teacher.handleCloseSlot(ctx, arg);
      case "cancel_slot":
        return teacher.handleCancelSlot(ctx, arg);
      case "attend": {
        const [bookingId = "", value = ""] = arg.split(":");
        return teacher.handleAttendance(ctx, bookingId, value);
      }
      case "teacher":
        return teacher.handleTeacherChosen(ctx, arg);
      case "sd":
        return teacher.handleSlotDiscipline(ctx, arg);
    }
  }

  // ── Дирекция ──────────────────────────────────────────────
  if (ctx.role === "directorate") {
    switch (head) {
      case "all_slots":
        return directorate.handleAllSlots(ctx);
      case "all_bookings":
        return directorate.handleAllBookings(ctx);
      case "pay":
        if (arg) {
          const [bookingId = "", value = ""] = arg.split(":");
          return directorate.handlePayment(ctx, bookingId, value === "paid");
        }
        return directorate.handlePaymentMenu(ctx);
      case "import":
        return directorate.handleImportPrompt(ctx);
      case "room":
        return directorate.handleRoomMenu(ctx);
      case "pick_room":
        return directorate.handleRoomPicked(ctx, arg);
      case "export":
        return directorate.handleExport(ctx);
      case "create_slot":
        return teacher.handleCreateSlot(ctx);
      case "teacher":
        return teacher.handleTeacherChosen(ctx, arg);
      case "sd":
        return teacher.handleSlotDiscipline(ctx, arg);
      case "cancel_slot":
        return directorate.handleCancelSlot(ctx, arg);
    }
  }

  await ctx.send(texts.system.unknown);
}

async function routeText(ctx: BotContext, text: string): Promise<void> {
  const trimmed = text.trim();

  if (trimmed.startsWith("/start")) {
    const payload = trimmed.slice("/start".length).trim() || undefined;
    return handleStart(ctx, payload);
  }

  switch (trimmed) {
    case "Мои записи":
      return student.handleMyBookings(ctx);
    case "Мои сессии":
      return ctx.role === "teacher" ? teacher.handleMySlots(ctx) : ctx.send(texts.system.unknown);
    case "Создать сессию":
      return ctx.role === "student" ? ctx.send(texts.system.unknown) : teacher.handleCreateSlot(ctx);
    case "Все сессии":
      return ctx.role === "directorate" ? directorate.handleAllSlots(ctx) : ctx.send(texts.system.unknown);
    case "Записи":
      return ctx.role === "directorate" ? directorate.handleAllBookings(ctx) : ctx.send(texts.system.unknown);
    case "Отметить оплату":
      return ctx.role === "directorate" ? directorate.handlePaymentMenu(ctx) : ctx.send(texts.system.unknown);
    case "Импорт реестра":
      return ctx.role === "directorate" ? directorate.handleImportPrompt(ctx) : ctx.send(texts.system.unknown);
    case "Сменить аудиторию":
      return ctx.role === "directorate" ? directorate.handleRoomMenu(ctx) : ctx.send(texts.system.unknown);
    case "Выгрузить CSV":
      return ctx.role === "directorate" ? directorate.handleExport(ctx) : ctx.send(texts.system.unknown);
  }

  // Ответы на ожидаемые вопросы — по состоянию сессии.
  switch (ctx.session.state) {
    case "AWAIT_FIO":
      return student.handleFio(ctx, trimmed);
    case "AWAIT_GROUP":
      return student.handleGroup(ctx, trimmed);
    case "AWAIT_ROOM":
      return ctx.role === "directorate" ? directorate.handleRoom(ctx, trimmed) : ctx.send(texts.system.unknown);
    case "AWAIT_REGISTRY_FILE":
      return ctx.role === "directorate" ? directorate.handleImport(ctx, trimmed) : ctx.send(texts.system.unknown);
    case "AWAIT_PAYMENT_TARGET":
      return ctx.role === "directorate" ? directorate.handlePaymentTarget(ctx, trimmed) : ctx.send(texts.system.unknown);
    case "AWAIT_SLOT_STARTS_AT":
      return teacher.handleSlotStartsAt(ctx, trimmed);
    case "AWAIT_SLOT_ROOM":
      return teacher.handleSlotRoom(ctx, trimmed);
    default:
      break;
  }

  await ctx.send(texts.system.help);
}

async function routeFile(ctx: BotContext): Promise<void> {
  const file = ctx.event.file;

  // Чек студента.
  if (ctx.role === "student" && ctx.session.state === "AWAIT_RECEIPT_FILE") {
    const bookingId = ctx.session.data.bookingId;
    if (!bookingId) {
      await ctx.send(texts.system.unknown);
      return;
    }

    const buffer = ctx.deps.config.MOCK_MAX
      ? Buffer.from(JSON.stringify(file ?? {}))
      : await download(file?.url ?? "");

    const { path, hash } = await saveReceipt(buffer, ctx.deps.config.FILES_DIR, bookingId);

    try {
      await ctx.deps.bookings.attachReceipt(bookingId, { sha256: hash, path });
    } catch (error) {
      if (error instanceof BookingError && error.code === "receipt_used_elsewhere") {
        await ctx.send(texts.student.receiptUsedElsewhere);
        return;
      }
      throw error;
    }

    const booking = await ctx.deps.prisma.booking.findUnique({ where: { id: bookingId } });
    await ctx.send(texts.student.receiptAccepted(booking ? bookingNumber(booking.seq) : ""));
    await ctx.deps.sessions.reset(ctx.event.userId);
    return;
  }

  await ctx.send(texts.system.unknown);
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Не удалось скачать файл: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
