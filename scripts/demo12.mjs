/**
 * Прогон демо-сценария ТЗ §12 против ЖИВОГО сервера (не через тестовый инжект).
 *
 * Запуск:
 *   npm run db:reset && npm run db:seed   # чистый стенд
 *   npm run dev                           # (или docker compose up)
 *   node scripts/demo12.mjs <DEEP_LINK>   # DEEP_LINK печатает сид
 *
 * Порт: BASE=http://localhost:3000 по умолчанию; задайте BASE, если другой
 * (на этой машине 3000 занят панелью отдела, поэтому BASE=http://localhost:3100).
 *
 * 19 проверок: healthz, эмулятор, запись студента, список преподавателя,
 * отметка оплаты, импорт реестра, смена аудитории, отмена сессии, CSV.
 * Код возврата: 0 — все шаги пройдены, 2 — стенд не чистый (нужен db:reset).
 */
import { readFile } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? "dev-service-token";
const CSV_PATH = new URL("../prisma/fixtures/registry-demo.csv", import.meta.url);
const token = process.argv[2];
/** Метка времени старта: уведомления искать только среди пришедших после неё. */
const startedAt = new Date().toISOString();

const fails = [];
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) fails.push(name);
};
const json = async (url, opts) => {
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};
const inject = (payload) =>
  json("/mock/max/inject", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
const history = async (userId) =>
  (await json(`/mock/history?userId=${userId}`)).body.messages ?? [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastText = (rows) => rows.at(-1)?.text ?? "";
const kbdOf = (rows) =>
  [...rows].reverse().find((m) => Array.isArray(m.keyboard?.buttons) && m.keyboard.buttons.length);
const buttonsOf = (rows) => (kbdOf(rows)?.keyboard.buttons ?? []).flat();
/**
 * Уведомления уходят через очередь — ждём их. Берём ПОСЛЕДНЕЕ совпадение
 * и только среди сообщений, пришедших после старта прогона: иначе сообщение
 * прошлого прогона засчиталось бы как успех текущего.
 */
const waitFor = async (userId, substring) => {
  for (let i = 0; i < 20; i++) {
    const rows = (await history(userId)).filter((m) => m.at >= startedAt);
    const hits = rows.filter((m) => m.text.includes(substring));
    if (hits.length) return hits[hits.length - 1].text;
    await sleep(300);
  }
  return "";
};

/**
 * Мягкий выход: process.exit() на Windows падает с
 * «Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)», пока висят
 * keep-alive-сокеты undici. Поэтому ставим код возврата и даём процессу
 * завершиться самому.
 */
function finish(code) {
  process.exitCode = code;
}

async function main() {
  if (!token) {
    console.log(
      "Укажите DEEP_LINK первым аргументом: node scripts/demo12.mjs rt_<дисциплина>_<сессия>",
    );
    finish(1);
    return;
  }

  // 0. Стенд должен быть чистым: демо создаёт запись студенту, и второй прогон
  //    упрётся в «у вас уже есть активная запись на эту дисциплину».
  const slots = (await json("/internal/slots", { headers: { "X-Service-Token": SERVICE_TOKEN } }))
    .body;
  const csvBefore = await (
    await fetch(`${BASE}/internal/export/bookings.csv`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
    })
  ).text();
  if (
    (Array.isArray(slots) ? slots.length : 0) !== 1 ||
    csvBefore.includes("Иванов Иван Иванович")
  ) {
    console.log(
      "СТЕНД НЕ ЧИСТЫЙ: слотов на стенде — " +
        (Array.isArray(slots) ? slots.length : "?") +
        ", запись демо-студента уже есть: " +
        csvBefore.includes("Иванов Иван Иванович") +
        ". Выполните npm run db:reset && npm run db:seed и повторите.",
    );
    finish(2);
    return;
  }

  // 1. healthz
  const health = await json("/healthz");
  ok(
    "шаг 1: /healthz",
    health.status === 200 && health.body.db === "ok" && health.body.redis === "ok",
    JSON.stringify(health.body),
  );

  // 2. страница эмулятора
  const page = await json("/mock/");
  ok(
    "шаг 2: /mock/ отдаёт HTML",
    page.status === 200 && String(page.body).includes('id="chat"'),
    `HTTP ${page.status}`,
  );

  // 3. студент 1001: /start <токен> → ФИО → группа → «Всё верно» → «Пропустить»
  await inject({ userId: "1001", text: `/start ${token}` });
  let s = await history("1001");
  ok(
    "шаг 3: выбор дисциплины",
    lastText(s).includes("Открытые сессии по дисциплине"),
    lastText(s).split("\n")[0],
  );

  const slotBtn = buttonsOf(s).find((b) => String(b.callbackData).startsWith("s:"));
  ok("шаг 3: кнопка сессии в истории", Boolean(slotBtn), slotBtn?.callbackData ?? "нет клавиатуры");
  if (slotBtn) await inject({ userId: "1001", callbackData: slotBtn.callbackData });

  await inject({ userId: "1001", text: "Иванов Иван Иванович" });
  await inject({ userId: "1001", text: "ГР-14" });
  s = await history("1001");
  const confirmMsg = lastText(s);
  ok(
    "шаг 3: подтверждение данных",
    confirmMsg.includes("ФИО: Иванов Иван Иванович") && confirmMsg.includes("ГР-14"),
    confirmMsg.replace(/\n/g, " | "),
  );

  const yesBtn = buttonsOf(s).find((b) => b.callbackData === "yes");
  if (yesBtn) await inject({ userId: "1001", callbackData: yesBtn.callbackData });
  s = await history("1001");
  ok(
    "шаг 3: номер записи и предложение чека",
    /B-\d+/.test(lastText(s)) && lastText(s).includes("чек"),
    lastText(s).replace(/\n/g, " | "),
  );

  const skipBtn = buttonsOf(s).find((b) => b.callbackData === "skip_receipt");
  if (skipBtn) await inject({ userId: "1001", callbackData: skipBtn.callbackData });
  s = await history("1001");
  const bookedMsg = lastText(s);
  const bookingRef = bookedMsg.match(/B-\d+/)?.[0];
  ok(
    "шаг 3: пропуск чека без лжи",
    bookedMsg.includes("не приложен") && !bookedMsg.includes("Чек приложен"),
    bookedMsg.replace(/\n/g, " | "),
  );

  // 4. преподаватель 2001: мои сессии → список записавшихся
  await inject({ userId: "2001", text: "Мои сессии" });
  let t = await history("2001");
  const slotId = buttonsOf(t)
    .find((b) => String(b.callbackData).startsWith("booked:"))
    ?.callbackData.split(":")[1];
  ok("шаг 4: сессия преподавателя видна", Boolean(slotId), slotId ? "" : "нет кнопок");
  if (slotId) await inject({ userId: "2001", callbackData: `booked:${slotId}` });
  t = await history("2001");
  ok(
    "шаг 4: запись без чека видна преподавателю",
    lastText(t).includes("Иванов Иван Иванович") || lastText(t).includes("Сидоров"),
    lastText(t).replace(/\n/g, " | "),
  );

  // 5. дирекция 3001: отметить оплату по номеру из шага 3
  await inject({ userId: "3001", text: "Отметить оплату" });
  if (bookingRef) await inject({ userId: "3001", text: bookingRef });
  let d = await history("3001");
  const payBtn = buttonsOf(d).find((b) => String(b.callbackData).startsWith("pay:"));
  ok("шаг 5: кнопка «Оплачено»", Boolean(payBtn), payBtn?.callbackData ?? "нет");
  if (payBtn) await inject({ userId: "3001", callbackData: payBtn.callbackData });
  d = await history("3001");
  ok(
    "шаг 5: оплата отмечена",
    lastText(d).includes("оплата отмечена"),
    lastText(d).replace(/\n/g, " | "),
  );

  const notified = await waitFor("1001", "подтверждена");
  ok("шаг 5: студенту уведомление об оплате", Boolean(notified), notified || "нет уведомления");

  // 6. импорт реестра (fixtures/registry-demo.csv)
  const csv = await readFile(CSV_PATH, "utf8");
  await inject({ userId: "3001", text: "Импорт реестра" });
  await inject({ userId: "3001", text: csv });
  d = await history("3001");
  const importMsg = lastText(d);
  ok(
    "шаг 6: строки реестра посчитаны",
    /Сопоставлено:\s*1/.test(importMsg) && /Не сопоставлено:\s*1/.test(importMsg),
    importMsg.replace(/\n/g, " | "),
  );

  // 7. смена аудитории: выбрать сессию → ввести новую аудиторию
  await inject({ userId: "3001", text: "Сменить аудиторию" });
  d = await history("3001");
  const pickBtn = buttonsOf(d).find((b) => String(b.callbackData).startsWith("pick_room:"));
  ok(
    "шаг 7: список сессий для смены аудитории",
    Boolean(pickBtn),
    pickBtn?.callbackData ?? "нет кнопок",
  );
  if (pickBtn) await inject({ userId: "3001", callbackData: pickBtn.callbackData });
  await inject({ userId: "3001", text: "Ауд-777" });
  d = await history("3001");
  ok(
    "шаг 7: аудитория изменена",
    lastText(d).includes("Аудитория изменена"),
    lastText(d).replace(/\n/g, " | "),
  );

  const roomNote = await waitFor("1001", "Аудитория изменена");
  ok(
    "шаг 7: студенту уведомление о новой аудитории",
    Boolean(roomNote),
    roomNote || "нет уведомления",
  );

  // 8. отмена сессии преподавателем
  await inject({ userId: "2001", text: "Мои сессии" });
  t = await history("2001");
  const cancelBtn = buttonsOf(t).find((b) => String(b.callbackData).startsWith("cancel_slot:"));
  if (cancelBtn) await inject({ userId: "2001", callbackData: cancelBtn.callbackData });
  t = await history("2001");
  ok(
    "шаг 8: «Сессия отменена»",
    lastText(t).includes("Сессия отменена"),
    lastText(t).replace(/\n/g, " | "),
  );

  const cancelNote = await waitFor("1001", "Сессия отменена");
  ok("шаг 8: студенту уведомление об отмене", Boolean(cancelNote), cancelNote || "нет уведомления");

  // 9. CSV-выгрузка
  const csvOut = await fetch(`${BASE}/internal/export/bookings.csv`, {
    headers: { "X-Service-Token": SERVICE_TOKEN },
  });
  const csvText = await csvOut.text();
  ok(
    "шаг 9: выгрузка CSV",
    csvOut.status === 200 && csvText.includes("booking_id,student_fio") && csvText.includes("B-"),
    csvText.split("\n").slice(0, 2).join(" / "),
  );

  console.log(
    fails.length ? `\nНЕ ПРОШЛО: ${fails.length} -> ${fails.join("; ")}` : "\nВСЕ ШАГИ ПРОЙДЕНЫ",
  );
  finish(fails.length ? 1 : 0);
}

await main();
