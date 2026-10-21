/**
 * Простой парсер реестра для MVP (§9 ТЗ).
 * Формат временный и требует подтверждения бухгалтерией: колонки строго
 * fio,amount,paid_at,purpose. Когда придёт настоящий реестр — меняется только этот файл.
 */

export interface ParsedRow {
  fio: string;
  fioNorm: string;
  amount: number;
  paidAt: Date | null;
  purpose: string | null;
  errors: string[];
}

export const REGISTRY_COLUMNS = ["fio", "amount", "paid_at", "purpose"] as const;

/** Нормализация ФИО: регистр, ё/е, пробелы, дефисы. */
export function normalizeFio(raw: string): string {
  return raw
    .replace(/ё/g, "е")
    .replace(/Ё/g, "Е")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Разбор одной строки CSV с учётом кавычек и запятых внутри поля. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseAmount(raw: string): number | null {
  const value = Number.parseInt(raw.replace(/\s/g, ""), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseDate(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCMonth() !== Number(month) - 1) return null;
  return date;
}

export function parseRegistryCsv(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0] as string).map((c) => c.trim().toLowerCase());
  const missing = REGISTRY_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`Реестр: нет обязательных колонок ${missing.join(", ")}`);
  }

  const index = new Map(REGISTRY_COLUMNS.map((column) => [column, header.indexOf(column)]));

  return lines.slice(1).map((line) => {
    const fields = splitCsvLine(line);
    const errors: string[] = [];

    const fio = (fields[index.get("fio") ?? -1] ?? "").trim();
    const amountRaw = fields[index.get("amount") ?? -1] ?? "";
    const paidAtRaw = fields[index.get("paid_at") ?? -1] ?? "";
    const purpose = fields[index.get("purpose") ?? -1]?.trim() || null;

    if (!fio) errors.push("пустое ФИО");

    const amount = parseAmount(amountRaw);
    if (amount === null) errors.push(`некорректная сумма «${amountRaw}»`);

    const paidAt = parseDate(paidAtRaw);
    if (paidAtRaw && paidAt === null) errors.push(`некорректная дата «${paidAtRaw}»`);

    return { fio, fioNorm: normalizeFio(fio), amount: amount ?? 0, paidAt, purpose, errors };
  });
}
