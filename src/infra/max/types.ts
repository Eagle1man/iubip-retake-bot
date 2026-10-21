/** Типы клиента MAX. SDK не тянем — два метода на fetch достаточно. */

export interface KeyboardButton {
  text: string;
  callbackData: string;
}

export interface MaxKeyboard {
  buttons: KeyboardButton[][];
}

export interface MaxClient {
  /**
   * kind — семантика уведомления (slot_cancelled, room_change…).
   * Нужен mock-клиенту, чтобы вести журнал с теми же типами, что и боевой воркер;
   * боевой клиент его игнорирует.
   */
  sendMessage(
    userId: string,
    text: string,
    keyboard?: MaxKeyboard,
    kind?: string,
  ): Promise<{ messageId: string }>;
}

export type MaxClientKind = "mock" | "real";

export interface IncomingEvent {
  userId: string;
  text?: string;
  callbackData?: string;
  file?: { fileId: string; url?: string; name?: string };
}
