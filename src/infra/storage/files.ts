import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Хранение чеков на диске. Имя файла — sha256, чтобы дубликаты не плодили копии. */
export async function saveReceipt(
  buffer: Buffer,
  filesDir: string,
  bookingId: string,
): Promise<{ path: string; hash: string }> {
  const hash = sha256(buffer);
  await mkdir(filesDir, { recursive: true });
  const path = join(filesDir, `${bookingId}-${hash.slice(0, 16)}.bin`);
  await writeFile(path, buffer);
  return { path, hash };
}
