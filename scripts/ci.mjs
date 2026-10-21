/**
 * CI-прогон MVP: качество кода, тесты и (если доступен Docker) сборка образа
 * с e2e-прогоном внутри compose.
 *
 * Запуск:
 *   npm run ci                      # полный прогон; Docker-этапы пропускаются, если его нет
 *   npm run ci -- --require-docker  # падать, если Docker недоступен (режим CI)
 *   npm run ci -- --skip-docker     # без Docker-этапов
 *
 * Шаги: проверка compose и переменных → lint → типы → unit+integration → e2e →
 *        compose config → docker build → e2e в контейнере.
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

/**
 * Проверки, которые работают без Docker.
 *
 * 1. В compose не должно быть обязательных подстановок ${VAR:?текст}: compose
 *    интерполирует переменные для ВСЕХ сервисов, включая сервисы за неактивным
 *    профилем. Такая подстановка ломает и `docker compose up` без .env, и CI,
 *    где боевые секреты не заданы. Обязательность проверяет приложение.
 * 2. В .env.production.example должны быть переменные, нужные боту в бою.
 */
function checkComposeAndEnv() {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const example = readFileSync(".env.production.example", "utf8");

  // Комментарии не считаем: пример «${VAR:?текст}» в пояснении — не подстановка.
  const composeCode = compose
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");

  const strict = [...new Set([...composeCode.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]))];
  console.log(`\n=== compose: обязательных подстановок ${strict.length}`);
  if (strict.length > 0) {
    console.error(
      `--- ПРОВАЛ: в compose есть ${strict.join(", ")} — compose интерполирует их и для сервисов ` +
        `за неактивным профилем: сломаются и CI, и демо-стенд без .env.`,
    );
    process.exit(1);
  }
  console.log("--- OK: обязательных подстановок нет (обязательность проверяет приложение)");

  const required = [
    "MAX_BOT_TOKEN",
    "MAX_WEBHOOK_SECRET",
    "SERVICE_TOKEN",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
  ];
  const missing = required.filter((name) => !new RegExp(`^${name}=.+$`, "m").test(example));
  console.log(`=== боевой контур: нужных переменных ${required.length}`);
  if (missing.length > 0) {
    console.error(`--- ПРОВАЛ: нет в .env.production.example: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`--- OK: все описаны (${required.join(", ")})`);
}

function dockerStatus() {
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

function composePluginStatus() {
  const result = spawnSync("docker", ["compose", "version"], { stdio: "pipe", encoding: "utf8" });
  return result.status === 0
    ? { ok: true, version: (result.stdout ?? "").trim() }
    : { ok: false, reason: (result.stderr ?? result.stdout ?? "").trim() || "docker compose version → ошибка" };
}

console.log(`CI-прогон iubip-retake-bot, Node ${process.version}, платформа ${process.platform}`);

checkComposeAndEnv();

localStep("lint", "eslint/bin/eslint.js", ["."]);
localStep("типы", "typescript/bin/tsc", ["--noEmit", "-p", "tsconfig.eslint.json"]);
localStep("unit+integration", "vitest/vitest.mjs", ["run"]);
localStep("e2e", "vitest/vitest.mjs", ["run", "--config", "vitest.e2e.config.ts"]);

const DOCKER_STEPS = ["compose config", "docker build", "compose e2e"];

if (skipDocker) {
  for (const name of DOCKER_STEPS) console.log(`\n=== ${name}: ПРОПУЩЕН (--skip-docker)`);
} else {
  const docker = dockerStatus();
  const compose = composePluginStatus();

  if (!docker.ok) {
    const message = `Docker недоступен: ${docker.reason}`;
    if (requireDocker) {
      console.error(`\n=== ${DOCKER_STEPS.join(", ")}: ПРОВАЛ — ${message}`);
      process.exit(1);
    }
    for (const name of DOCKER_STEPS) console.log(`\n=== ${name}: ПРОПУЩЕН — ${message}`);
    console.log("    (чтобы прогнать Docker-этапы, нужен запущенный Docker; в CI он есть)");
  } else {
    console.log(`\nDocker доступен: ${docker.version}`);
    if (!compose.ok) {
      const message = `нет плагина docker compose: ${compose.reason}`;
      if (requireDocker) {
        console.error(`\n=== compose config, compose e2e: ПРОВАЛ — ${message}`);
        process.exit(1);
      }
      console.log(`\n=== compose config: ПРОПУЩЕН — ${message}`);
      console.log("=== compose e2e: ПРОПУЩЕН");
    } else {
      console.log(`docker compose доступен: ${compose.version}`);
      step("compose config", "docker", ["compose", "config", "--quiet"]);
    }
    step("docker build", "docker", ["build", "-t", "iubip-retake-bot:ci", "."]);
    if (compose.ok) {
      step(
        "compose e2e",
        "docker",
        ["compose", "--profile", "test", "run", "--rm", "e2e"],
        { env: { ...process.env, COMPOSE_PROGRESS: "plain" } },
      );
    } else {
      console.log("\n=== compose e2e: ПРОПУЩЕН — нет плагина docker compose");
    }
  }
}

console.log("\nCI: ВСЕ ШАГИ ПРОЙДЕНЫ");
