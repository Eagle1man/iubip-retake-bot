/**
 * Тексты бота — единственное место, где они живут.
 * Ограничение из §10: студент НЕ видит число записавшихся.
 * Проверка — test/unit/texts.test.ts (ни один студенческий шаблон не содержит «записал»/count).
 */

export interface BotReply {
  text: string;
  keyboard?: { buttons: { text: string; callbackData: string }[][] };
}

const money = (amount: number) => `${amount} ₽`;

export const texts = {
  student: {
    start: () =>
      "Здравствуйте!\n\nЭто бот записи на пересдачу. Выберите дисциплину — покажу открытые сессии.",
    chooseDiscipline: "Выберите дисциплину:",
    chooseSlot: (discipline: string) => `Открытые сессии по дисциплине «${discipline}»:`,
    slotLine: (slot: { room: string; startsAt: string; amount: number }) =>
      `${slot.startsAt} · ауд. ${slot.room} · ${money(slot.amount)}`,
    askFio: "Введите ФИО полностью (например: Петрова Анна Ивановна).",
    askGroup: "Введите номер группы (например: ГР-12).",
    confirm: (data: { fio: string; group: string; slot: string }) =>
      `Проверьте данные:\n\nФИО: ${data.fio}\nГруппа: ${data.group}\nСессия: ${data.slot}\n\nВсё верно?`,
    created: (number: string) =>
      `Вы записаны! Номер записи: ${number}.\n\nПриложите чек об оплате или пропустите этот шаг — чек не обязателен.`,
    receiptAccepted: (number: string) => `Чек приложен к записи ${number}.`,
    receiptSkipped: (number: string) => `Чек к записи ${number} не приложен.`,
    receiptDuplicate: (number: string) => `Этот чек уже приложен к записи ${number}.`,
    receiptUsedElsewhere: "Этот чек уже приложен к другой записи на эту сессию.",
    myBookings: (list: string[]) =>
      list.length > 0 ? `Ваши записи:\n\n${list.join("\n")}` : "У вас пока нет записей.",
    bookingLine: (b: { number: string; discipline: string; startsAt: string; room: string; status: string }) =>
      `${b.number} · ${b.discipline} · ${b.startsAt} · ауд. ${b.room} · ${b.status}`,
    cancelled: (number: string) => `Запись ${number} отменена.`,
    cancelForbidden: "Отменить эту запись уже нельзя — сессия слишком близко.",
    duplicate: "У вас уже есть активная запись на эту дисциплину.",
    registrationClosed: "Регистрация на эту сессию закрыта. Выберите другую сессию.",
    admitted: "Вы допущены к пересдаче. Оплата не блокирует участие.",
    noSlots: "Открытых сессий по этой дисциплине нет.",
  },
  teacher: {
    greeting: (fio: string) => `Здравствуйте, ${fio}! Вы вошли как преподаватель.`,
    mySlots: (list: string[]) =>
      list.length > 0 ? `Ваши сессии:\n\n${list.join("\n")}` : "У вас нет сессий.",
    slotLine: (s: { slotId: string; discipline: string; startsAt: string; room: string; booked: number }) =>
      `${s.discipline} · ${s.startsAt} · ауд. ${s.room} · Записалось: ${s.booked}`,
    bookedList: (total: number, list: string[]) =>
      `Записалось: ${total}\n\n${list.length > 0 ? list.join("\n") : "Пока никто не записался."}`,
    studentLine: (b: { fio: string; group: string; paymentStatus: string; hasReceipt: boolean; attendance: string | null }) =>
      `${b.fio} · ${b.group} · оплата: ${b.paymentStatus} · чек: ${b.hasReceipt ? "есть" : "нет"}${
        b.attendance ? ` · явка: ${b.attendance}` : ""
      }`,
    askFio: "Введите ФИО преподавателя, от имени которого создаётся сессия.",
    askStartsAt: "Введите дату и время сессии (ГГГГ-ММ-ДД ЧЧ:ММ).",
    askRoom: "Введите аудиторию.",
    askDiscipline: "Выберите дисциплину для сессии.",
    slotCreated: (id: string) => `Сессия создана: ${id}.`,
    slotConflict: "У этого преподавателя уже есть сессия в это время. Выберите другое время.",
    attendanceMarked: "Явка отмечена.",
    slotClosed: "Сессия закрыта: новые записи не принимаются.",
    slotCancelled: (notified: number) => `Сессия отменена. Уведомлений отправлено: ${notified}.`,
    slotAlreadyCancelled: "Сессия уже отменена.",
    slotNotFound: "Сессия не найдена.",
    notTeacher: "Этот раздел доступен только преподавателю.",
  },
  directorate: {
    greeting: "Вы вошли как дирекция.",
    allSlots: (list: string[]) => (list.length > 0 ? list.join("\n") : "Сессий нет."),
    bookingsByStatus: (list: string[]) => (list.length > 0 ? list.join("\n") : "Записей с таким статусом нет."),
    paymentMarked: (number: string, status: string) => `Запись ${number}: оплата отмечена как «${status}».`,
    askRoom: "Введите новую аудиторию.",
    roomChanged: (notified: number) => `Аудитория изменена. Уведомлений отправлено: ${notified}.`,
    askRegistryFile: "Пришлите CSV-реестр (колонки: fio,amount,paid_at,purpose).",
    importResult: (r: { rowsTotal: number; rowsMatched: number; rowsUnmatched: string[] }) =>
      `Реестр обработан.\nВсего строк: ${r.rowsTotal}\nСопоставлено: ${r.rowsMatched}\nНе сопоставлено: ${r.rowsUnmatched.length}${
        r.rowsUnmatched.length > 0 ? `\n\n${r.rowsUnmatched.join("\n")}` : ""
      }`,
    exportLink: "Выгрузка: GET /internal/export/bookings.csv",
    askBookingNumber: "Введите номер записи (например B-1).",
    bookingNotFound: "Запись с таким номером не найдена.",
    notDirectorate: "Этот раздел доступен только дирекции.",
    slotCancelled: (notified: number) => `Сессия отменена. Уведомлений отправлено: ${notified}.`,
    slotAlreadyCancelled: "Сессия уже отменена.",
  },
  system: {
    help: [
      "Команды:",
      "/start — начать запись",
      "«Мои записи» — список ваших записей",
      "«Мои сессии» — сессии преподавателя",
      "«Все сессии» — сессии дирекции",
      "«Записи» — записи дирекции",
    ].join("\n"),
    unknown: "Не понял команду. Нажмите кнопку или /start.",
    error: "Что-то пошло не так. Попробуйте ещё раз.",
  },
} as const;

/** Шаблоны, которые видит студент. Тест гарантирует, что в них нет счётчика записавшихся. */
export const STUDENT_TEXT_KEYS = [
  "start",
  "chooseDiscipline",
  "chooseSlot",
  "slotLine",
  "askFio",
  "askGroup",
  "confirm",
  "created",
  "receiptAccepted",
  "receiptSkipped",
  "receiptDuplicate",
  "receiptUsedElsewhere",
  "myBookings",
  "bookingLine",
  "cancelled",
  "cancelForbidden",
  "duplicate",
  "registrationClosed",
  "admitted",
  "noSlots",
] as const;
