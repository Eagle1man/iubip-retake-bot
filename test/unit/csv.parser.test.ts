import { describe, expect, it } from "vitest";
import { normalizeFio, parseRegistryCsv } from "../../src/domain/registry/csv.parser.js";

describe("normalizeFio", () => {
  it("приводит к нижнему регистру и схлопывает пробелы", () => {
    expect(normalizeFio("Иванов   Иван  Иванович")).toBe("иванов иван иванович");
  });

  it("ё → е", () => {
    expect(normalizeFio("Пётр")).toBe("петр");
    expect(normalizeFio("Ёлочкин")).toBe("елочкин");
  });

  it("убирает пробелы вокруг дефиса", () => {
    expect(normalizeFio("Сидоров - Пётр")).toBe("сидоров-петр");
    expect(normalizeFio("А-Б  В -Г")).toBe("а-б в-г");
  });

  it("обрезает пробелы по краям", () => {
    expect(normalizeFio("  Иван Иванов  ")).toBe("иван иванов");
  });
});

describe("parseRegistryCsv", () => {
  const header = "fio,amount,paid_at,purpose\n";

  it("разбирает валидную строку, включая запятую внутри кавычек", () => {
    const rows = parseRegistryCsv(
      `${header}Сидоров Пётр Петрович,500,2026-10-14,"Оплата за Сидоров П.П., группа ГР-13"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.fio).toBe("Сидоров Пётр Петрович");
    expect(rows.at(0)?.fioNorm).toBe("сидоров петр петрович");
    expect(rows.at(0)?.amount).toBe(500);
    expect(rows.at(0)?.paidAt?.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(rows.at(0)?.purpose).toBe("Оплата за Сидоров П.П., группа ГР-13");
    expect(rows.at(0)?.errors).toEqual([]);
  });

  it("ошибка при некорректной дате (2026-13-40)", () => {
    const rows = parseRegistryCsv(`${header}А,500,2026-13-40,x`);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.paidAt).toBeNull();
    expect(rows.at(0)?.errors).toContainEqual(expect.stringContaining("некорректная дата"));
  });

  it("ошибка при нечисловой сумме", () => {
    const rows = parseRegistryCsv(`${header}А,пятьсот,2026-10-14,x`);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.amount).toBe(0);
    expect(rows.at(0)?.errors).toContainEqual(expect.stringContaining("некорректная сумма"));
  });

  it("пустой файл → []", () => {
    expect(parseRegistryCsv("")).toEqual([]);
    expect(parseRegistryCsv("\n\n")).toEqual([]);
  });

  it("отсутствующая обязательная колонка → исключение", () => {
    expect(() => parseRegistryCsv("fio,amount,purpose\nА,500,x")).toThrow(
      /нет обязательных колонок/,
    );
  });
});
