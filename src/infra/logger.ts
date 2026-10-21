import { config } from "../config.js";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const LEVELS: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

/**
 * Значения, которые нельзя печатать в лог: токены, секреты, пароли.
 * Проверка — тестом (§11.1: токен не попадает в лог).
 */
const SECRET_KEYS = ["token", "secret", "password", "authorization", "cookie"] as const;

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? "***" : redact(val);
    }
    return out;
  }
  return value;
}

function redactString(text: string): string {
  let out = text;
  for (const secret of [config.MAX_BOT_TOKEN, config.MAX_WEBHOOK_SECRET, config.SERVICE_TOKEN, config.PAYMENT_API_TOKEN]) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEYS.some((secret) => lower.includes(secret));
}

function write(level: LogLevel, message: string, payload?: unknown): void {
  if (LEVELS[level] > LEVELS[config.LOG_LEVEL as LogLevel]) return;
  const line = payload === undefined ? message : `${message} ${JSON.stringify(redact(payload))}`;
  const target = level === "error" || level === "fatal" ? process.stderr : process.stdout;
  target.write(`${new Date().toISOString()} [${level}] ${redactString(line)}\n`);
}

export const logger = {
  fatal: (message: string, payload?: unknown) => write("fatal", message, payload),
  error: (message: string, payload?: unknown) => write("error", message, payload),
  warn: (message: string, payload?: unknown) => write("warn", message, payload),
  info: (message: string, payload?: unknown) => write("info", message, payload),
  debug: (message: string, payload?: unknown) => write("debug", message, payload),
  trace: (message: string, payload?: unknown) => write("trace", message, payload),
};

/** Для тестов: собрать всё, что ушло в лог, в массив. */
export function createCollectingLogger(): { logger: typeof logger; lines: string[] } {
  const lines: string[] = [];
  const original = { ...logger };
  const collector: typeof logger = Object.fromEntries(
    (Object.keys(LEVELS) as LogLevel[]).map((level) => [
      level,
      (message: string, payload?: unknown) => {
        const line = payload === undefined ? message : `${message} ${JSON.stringify(payload)}`;
        lines.push(redactString(line));
        original[level](message, payload);
      },
    ]),
  ) as typeof logger;
  return { logger: collector, lines };
}
