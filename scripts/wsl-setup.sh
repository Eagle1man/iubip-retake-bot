#!/usr/bin/env bash
# Одноразовая настройка окружения для тестов: Postgres 16 + Redis 7 в WSL.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v psql >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq postgresql redis-server >/tmp/apt.log 2>&1 || { tail -20 /tmp/apt.log; exit 1; }
fi

service postgresql start >/dev/null 2>&1 || true
su postgres -c "psql -c \"CREATE USER iubip WITH PASSWORD 'iubip';\"" >/dev/null 2>&1 || true
su postgres -c "createdb -O iubip iubip_retake" >/dev/null 2>&1 || true

if ! command -v redis-server >/dev/null 2>&1; then
  apt-get install -y -qq redis-server >/tmp/apt-redis.log 2>&1
fi
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes
sleep 2

echo "postgres: $(pg_isready -h 127.0.0.1 -p 5432)"
echo "redis:    $(redis-cli ping)"
