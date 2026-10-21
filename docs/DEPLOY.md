# Развёртывание iubip-retake-bot

Runbook для двух режимов: **демо-стенд** (показ, без токена MAX) и **боевой
контур** (реальный MAX, TLS, без демо-данных).

> Публикацию на production выполняет человек. Агент готовит конфигурацию,
> скрипты и проверки — но не поднимает боевой контур сам.

---

## 1. Требования

| Что | Минимум | Зачем |
|---|---|---|
| Docker Engine | 24+ с плагином compose v2 | `docker compose` (не `docker-compose`) |
| Ресурсы | 2 vCPU, 4 ГБ RAM, 10 ГБ диск | Postgres + Redis + Node |
| Домен и TLS | домен на 80/443 (Caddy выпускает сертификат сам) | вебхук MAX |
| Доступ к MAX | бот в кабинете MAX, токен, секрет подписи | реальные сообщения |

## 2. Подготовка

```bash
cp .env.production.example .env
# затем заполнить .env: DB_PASSWORD, MAX_BOT_TOKEN, MAX_WEBHOOK_SECRET,
# SERVICE_TOKEN, PAYMENT_API_TOKEN
```

Пароль БД попадает в `DATABASE_URL` как есть — **без спецсимволов** (`@ : / ? #`),
иначе URL не разберётся. Compose собирает `DATABASE_URL` из `DB_USER`,
`DB_PASSWORD` и `DB_NAME`; задать URL целиком нельзя (`environment:` имеет
приоритет над `env_file`).

**Демо-стенду `.env` не нужен:** в compose у него значения по умолчанию
(база `iubip/iubip`, mock-режим). Обязательные подстановки `${VAR:?текст}`
в compose **не используются**: compose интерполирует переменные для всех
сервисов, включая сервисы за неактивным профилем, и такая подстановка сломала
бы и `docker compose up` без `.env`, и CI. Обязательность боевых секретов
проверяет само приложение при старте (см. §4).

## 3. Демо-стенд (без токена MAX)

```bash
docker compose up --build
```

Поднимаются `db`, `redis`, `app`: миграции (`prisma migrate deploy`), сид с
демо-данными, приложение в mock-режиме. Порт приложения настраивается:
`APP_PORT=3100 docker compose up --build` (если 3000 занят другой службой).

Проверка:

```bash
curl http://localhost:3000/healthz      # {"db":"ok","redis":"ok","mockMax":true}
docker compose logs app | grep DEEP_LINK # токен для демо-сценария §12
```

Демо-стенд: `http://localhost:3000/mock/` (эмулятор чата).

## 4. Боевой контур

```bash
docker compose --profile prod up -d app-prod db-prod redis-prod caddy
```

Сервисы перечислены **явно**: без имён compose поднял бы и демо-стенд
(`app` без профиля) — а он сеет демо-данные. У боевого контура **своя база**
(том `pgdata_prod`), так что демо-данные в боевые таблицы не попадают.

Что отличается от демо:

- `app-prod` — **без сида**: боевая база не наполняется демо-данными;
- `MOCK_MAX=false`, реальный `MAX_BOT_TOKEN`;
- наружу торчит только Caddy (80/443), приложение доступно лишь во внутренней сети;
- миграции применяются при старте (`prisma migrate deploy`).

**Обязательные секреты проверяет приложение**, а не compose: если
`MAX_BOT_TOKEN` или `MAX_WEBHOOK_SECRET` не заданы, контейнер `app-prod`
упадёт с сообщением «MAX_BOT_TOKEN обязателен, когда MOCK_MAX=false» (или
«MAX_WEBHOOK_SECRET обязателен…»), а не «required variable is missing».

### Проверка после старта

```bash
curl https://<домен>/healthz              # {"db":"ok","redis":"ok","mockMax":false}
curl -i https://<домен>/mock/             # ожидаем 404: mock выключен
curl -i -X POST https://<домен>/internal/slots   # ожидаем 401: нет X-Service-Token
```

Вебхук MAX: `POST /internal/webhook/max` с заголовком `x-max-signature`.
**Важно:** сейчас подпись проверяется сравнением заголовка с секретом
(см. `src/api/routes/max.ts`, `verifyWebhook`). Настоящий алгоритм подписи MAX
не документирован в ТЗ — перед боевым включением функцию проверки нужно заменить
на HMAC по документации площадки. Иначе вебхук будет отклоняться.

## 5. Приёмка (проверка перед выкаткой)

```bash
npm ci
npm run ci                 # lint, типы, unit+integration, e2e
npm run ci -- --require-docker   # + сборка образа и e2e в compose (нужен Docker)
```

Тот же прогон идёт в CI: `.github/workflows/ci.yml` (Node 20, Postgres 16,
Redis 7, Docker на раннере). Docker-этап закрывает критерий приёмки
«`docker compose up` на чистой машине» — на машине без Docker он честно
пропускается с пометкой, а не молча.

## 6. Обновление версии

```bash
cd /opt/iubip-retake-bot
git pull
docker compose exec db-prod pg_dump -U "$DB_USER" "$DB_NAME" > backup-$(date +%F).sql
docker compose --profile prod up -d --build app-prod db-prod redis-prod caddy
docker compose logs -f app-prod
```

Миграции применяются при старте контейнера. **Правило:** файл миграции нельзя
править после её применения (Prisma откажется: P3008/P3009). Частичный
уникальный индекс дописывает `scripts/migrations-fix.mjs` — запускать его нужно
**до** первого применения миграции на целевой базе, и он кладёт индекс в ту
миграцию, где создаётся таблица `Booking`.

## 7. Откат

```bash
docker compose --profile prod down app-prod db-prod redis-prod caddy   # остановить контур
docker compose --profile prod up -d app-prod db-prod redis-prod caddy # поднять предыдущий коммит
```

Откат кода не откатывает миграции: если миграция необратима, восстанавливают базу
из бэкапа:

```bash
docker compose exec -T db-prod psql -U "$DB_USER" -d postgres < backup-2026-11-02.sql
```

## 8. Бэкапы

```bash
# Разовая выгрузка
docker compose exec db-prod pg_dump -U "$DB_USER" "$DB_NAME" | gzip > backup.sql.gz

# По расписанию (cron на сервере), копию забирать наружу отдельно
0 3 * * * cd /opt/iubip-retake-bot && docker compose exec -T db-prod pg_dump -U iubip iubip_retake | gzip > /var/backups/iubip-$(date +\%F).sql.gz
```

Каталог `FILES_DIR` (том `receipts_prod` в бою, `receipts` в демо; по
умолчанию `/data/receipts`) — чеки студентов; он не входит в дамп БД,
копируется отдельно.

## 9. Логи и диагностика

```bash
docker compose logs -f app-prod        # логи приложения
docker compose ps                      # состояние контейнеров и healthcheck
docker compose exec db-prod psql -U "$DB_USER" -d "$DB_NAME" -c "\dt"
```

Типовые проблемы:

| Симптом | Причина | Что делать |
|---|---|---|
| `relation "Booking" does not exist` при миграциях | частичный индекс попал не в свою миграцию | `scripts/migrations-fix.mjs` ищет миграцию с `CREATE TABLE "Booking"`; применить с нуля (`db:reset` на тестовой БД) |
| `P3009` / «migrations ... not applied» | миграция в папке изменена после применения | пересоздать схему на тестовой БД, на боевой — восстановить из бэкапа |
| `bind: address already in use` | порт 3000 занят другой службой | `APP_PORT=3100 docker compose up` |
| `MAX_WEBHOOK_SECRET обязателен` | не заполнен `.env` | заполнить и перезапустить |
| вебхук MAX отвечает 401 | подпись не совпадает | проверить формат подписи (см. §4) |

## 10. Что осталось за человеком

- выпуск сертификата и привязка домена (Caddy делает это сам при `up`, но DNS
  должен указывать на сервер);
- выдача и ротация `MAX_BOT_TOKEN`, `MAX_WEBHOOK_SECRET`, `SERVICE_TOKEN`;
- подтверждение боевого формата подписи вебхука и его реализация вместо заглушки;
- вебхук оплаты от `iubip-sbp-pay` (в MVP оплата отмечается дирекцией или
  импортом реестра);
- промышленный формат реестра бухгалтерии (сейчас — упрощённый CSV);
- напоминания за 24 ч и 2 ч (`REMINDERS_ENABLED=false`);
- наполнение базы реальными дисциплинами, преподавателями и сессиями.
