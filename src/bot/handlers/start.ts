import type { BotContext } from "../dispatcher.js";
import { btn, keyboard } from "../keyboards.js";
import { texts } from "../texts.js";
import { handleDirectorateGreeting } from "./directorate.js";
import { listOpenSlots } from "./student.js";
import { handleTeacherGreeting } from "./teacher.js";

/** Токен deep link: rt_<disciplineId>_<slotId>. */
export function parsePayload(payload: string | undefined): { disciplineId: string; slotId: string } | null {
  if (!payload) return null;
  const parts = payload.split("_");
  if (parts.length !== 3 || parts[0] !== "rt") return null;
  const disciplineId = parts[1] ?? "";
  const slotId = parts[2] ?? "";
  if (!disciplineId || !slotId) return null;
  return { disciplineId, slotId };
}

export async function handleStart(ctx: BotContext, payload: string | undefined): Promise<void> {
  if (ctx.role === "teacher") {
    await handleTeacherGreeting(ctx);
    return;
  }
  if (ctx.role === "directorate") {
    await handleDirectorateGreeting(ctx);
    return;
  }

  const parsed = parsePayload(payload);
  if (parsed) {
    ctx.session.data.payloadToken = payload;
    ctx.session.data.disciplineId = parsed.disciplineId;
    ctx.session.data.slotId = parsed.slotId;
  }

  await ctx.send(texts.student.start());
  await listOpenSlots(ctx, ctx.session.data.disciplineId);
}

/** Кнопки выбора дисциплины. */
export function disciplineKeyboard(disciplines: { id: string; name: string }[]) {
  return keyboard([...disciplines.map((d) => [btn(d.name, `d:${d.id}`)])]);
}

/** Кнопки выбора сессии. */
export function slotKeyboard(slots: { slotId: string; label: string }[]) {
  return keyboard(slots.map((s) => [btn(s.label, `s:${s.slotId}`)]));
}
