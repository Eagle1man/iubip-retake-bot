import { readFile } from "node:fs/promises";

const url = new URL("../../mock-ui/index.html", import.meta.url);

let cached: string | undefined;

/** Веб-эмулятор чата MAX. Файл один — он же демо-стенд (§8 ТЗ). */
export async function emulatorHtml(): Promise<string> {
  if (!cached) cached = await readFile(url, "utf8");
  return cached;
}

export async function setMockUiFile(file: string): Promise<void> {
  cached = file;
}
