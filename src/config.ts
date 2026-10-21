import { z } from "zod";
import { loadEnvFile } from "./infra/env-file.js";

// .env читаем здесь же: конфиг — первый, кто трогает окружение,
// а tsx/node не подгружают файл окружения сами (см. env-file.ts).
loadEnvFile();

/**
 * z.coerce.boolean() здесь не годится: Boolean("false") === true, то есть
 * MOCK_MAX=false молча превратился бы в true. Поэтому явный разбор строки.
 */
const boolFromEnv = z.preprocess((value) => {
  if (typeof value === "string") return value !== "" && value !== "false" && value !== "0";
  return Boolean(value);
}, z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL обязателен"),
  DATABASE_URL_TEST: z.string().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  MOCK_MAX: boolFromEnv.default(true),
  MAX_BOT_TOKEN: z.string().optional(),
  MAX_API_BASE: z.string().url().default("https://platform-api2.max.ru"),
  MAX_WEBHOOK_SECRET: z.string().optional(),
  MAX_BOT_NAME: z.string().optional(),

  PAYMENT_API_BASE: z.string().url().default("http://localhost:3200"),
  PAYMENT_API_TOKEN: z.string().default("dev-secret"),
  SERVICE_TOKEN: z.string().min(1, "SERVICE_TOKEN обязателен").default("dev-service-token"),

  CANCEL_DEADLINE_HOURS: z.coerce.number().int().min(0).default(0),
  DEFAULT_ALERT_THRESHOLD: z.coerce.number().int().positive().default(30),
  TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(72),

  FILES_DIR: z.string().default("/data/receipts"),
  FILES_MAX_BYTES: z.coerce.number().int().positive().default(10485760),

  DIRECTORATE_CHAT_ID: z.string().default("dev-directorate"),

  REMINDERS_ENABLED: boolFromEnv.default(false),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Невалидное окружение:\n${issues}`);
}

const data = parsed.data;

/**
 * MOCK_MAX=false без токена — падение при старте, а не «тихая» работа без бота.
 * Иначе демо выглядит работающим, а сообщения уходят в никуда.
 */
if (!data.MOCK_MAX && !data.MAX_BOT_TOKEN) {
  throw new Error("MAX_BOT_TOKEN обязателен, когда MOCK_MAX=false");
}

/**
 * Секрет подписи вебхука в боевом режиме обязателен: без него подпись
 * проверяется против пустой строки, и вебхук либо не принимается вовсе,
 * либо (если проверку ослабить) принимается без проверки.
 */
if (!data.MOCK_MAX && !data.MAX_WEBHOOK_SECRET) {
  throw new Error("MAX_WEBHOOK_SECRET обязателен, когда MOCK_MAX=false");
}

export const config = Object.freeze(data);
export type AppConfig = typeof config;
