#!/usr/bin/env bash
# Выдать iubip право создавать базы (нужно Prisma для shadow database в migrate dev).
su postgres -c "psql -c 'ALTER USER iubip CREATEDB;'" >/dev/null
echo "CREATEDB: $(su postgres -c "psql -tAc \"SELECT rolcreatedb FROM pg_roles WHERE rolname='iubip'\"")"
