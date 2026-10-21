/**
 * CI-прогон MVP: качество кода, тесты и (если доступен Docker) сборка образа
 * с e2e-прогоном внутри compose.
 *
 * Запуск:
 *   npm run ci                 # полный прогон; Docker-этап пропускается, если его нет
 *   npm run ci -- --require-docker   # падать, если Docker недоступен (режим CI)
 *   npm run ci -- --skip-docker      # без Docker-этапов
 *
 * Шаги: lint → типы → unit+integration → e2e → docker build → compose e2e.
 * Первый упавший шаг останавливает прогон.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const flags = new Set(process.argv.slice(2));
const skipDocker = flags.has("--skip-docker");
const requireDocker = flags.has("--require-docker");

/**
 * Локальные бинарники запускаем через node напрямую, а не через npm/npx:
 * с Node 20.12+ запуск .cmd/.bat без shell запрещён (CVE-2024-27980),
 * а shell:true добавляет cmd.exe и разное поведение кавычек.
 */
const localStep = (name, relative, args = []) =>
  step(name, "node", [`node_modules/${relative}`, ...args]);

const run = (command, args, options = {}) =>
  spawnSync(command, args, { stdio: "inherit", shell: false, ...options });

function step(name, command, args) {
  console.log(`\n=== ${name}: ${command} ${args.join(" ")}`);
  const started = Date.now();
  const result = run(command, args);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.log(`--- ${name}: УПАЛ (код ${result.status}) за ${seconds} с`);
    process.exit(result.status ?? 1);
  }
  console.log(`--- ${name}: OK за ${seconds} с`);
}

function dockerAvailable() {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status === 0) {
    return { ok: true, version: (result.stdout ?? "").trim() };
  }
  return {
    ok: false,
    reason: (result.stderr ?? result.stdout ?? "").trim() || `docker version → код ${result.status}`,
  };
}

/**
 * Проверка без Docker: все переменные, объявленные в compose как обязательные
 * (${VAR:?текст}), должны быть в .env.production.example — иначе боевой контур
 * не поднимется, и это выяснится только на сервере.
 */
function checkRequiredEnvVars() {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const example = readFileSync(".env.production.example", "utf8");
  const required = [...new Set([...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]))];
  const missing = required.filter((name) => !new RegExp(`^${name}=`, "m").test(example));

  console.log(`\n=== переменные боевого контура: обязательных ${required.length}`);
  if (missing.length) {
    console.error(`--- ПРОВАЛ: нет в .env.production.example: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`--- OK: все обязательные переменные описаны (${required.join(", ")})`);
}

console.log(`CI-прогон iubip-retake-bot, Node ${process.version}, платформа ${process.platform}`);

checkRequiredEnvVars();

localStep("lint", "eslint/bin/eslint.js", ["."]);
localStep("типы", "typescript/bin/tsc", ["--noEmit", "-p", "tsconfig.eslint.json"]);
localStep("unit+integration", "vitest/vitest.mjs", ["run"]);
localStep("e2e", "vitest/vitest.mjs", ["run", "--config", "vitest.e2e.config.ts"]);

if (skipDocker) {
  console.log("\n=== docker build: ПРОПУЩЕН (--skip-docker)");
  console.log("=== compose e2e: ПРОПУЩЕН (--skip-docker)");
} else {
  const docker = dockerAvailable();
  if (!docker.ok) {
    const message = `Docker недоступен: ${docker.reason}`;
    if (requireDocker) {
      console.error(`\n=== docker build: ПРОВАЛ — ${message}`);
      process.exit(1);
    }
    console.log(`\n=== docker build: ПРОПУЩЕН — ${message}`);
    console.log("    (чтобы прогнать Docker-этапы, нужен запущенный Docker; в CI он есть)");
    console.log("=== compose e2e: ПРОПУЩЕН");
  } else {
    console.log(`\nDocker доступен: ${docker.version}`);
    step("compose config", "docker", ["compose", "config", "--quiet"]);
    step("docker build", "docker", ["build", "-t", "iubip-retake-bot:ci", "."]);
    step(
      "compose e2e",
      "docker",
      ["compose", "--profile", "test", "run", "--rm", "e2e"],
      { env: { ...process.env, COMPOSE_PROGRESS: "plain" } },
    );
  }
}

console.log("\nCI: ВСЕ ШАГИ ПРОЙДЕНЫ");
