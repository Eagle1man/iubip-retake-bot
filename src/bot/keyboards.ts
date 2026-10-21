import type { KeyboardButton, MaxKeyboard } from "../infra/max/types.js";

export function btn(text: string, callbackData: string): KeyboardButton {
  return { text, callbackData };
}

export function keyboard(rows: KeyboardButton[][]): MaxKeyboard {
  return { buttons: rows };
}

export const noKeyboard = undefined;
