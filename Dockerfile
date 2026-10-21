# syntax=docker/dockerfile:1
# Сборка и рантайм разделены: в рантайм не попадают тесты, dev-зависимости и исходники.
# Стадия build используется как есть для сервиса e2e в docker-compose (там нужны vitest).

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate \
  && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# prisma generate из стадии build: клиент должен совпадать со схемой по версии.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
# dist + всё, что нужно на старте: миграции, сид, эмулятор чата (§8).
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY mock-ui ./mock-ui

EXPOSE 3000

# migrate deploy → seed → запуск: так `docker compose up` даёт рабочий демо-стенд (§12).
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed && node dist/index.js"]
