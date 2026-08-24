#!/usr/bin/env bash
# Cloud Agent install: idempotent repository bootstrap.
#
# Runs after the repository is checked out. With environment builds this runs
# once to produce the baseline snapshot, so everything here is durable state:
# system packages, the local Postgres cluster + seeded databases, and installed
# node_modules. Per-boot process startup lives in start.sh instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PG_MAJOR=16
export DEBIAN_FRONTEND=noninteractive

echo "==> Ensuring system packages (postgresql, curl, unzip)"
if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq "postgresql-${PG_MAJOR}" "postgresql-contrib" curl unzip
fi

echo "==> Ensuring Bun is installed"
if ! command -v bun >/dev/null 2>&1 && [[ ! -x "$HOME/.bun/bin/bun" ]]; then
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

echo "==> Ensuring Postgres cluster is running"
if ! pg_lsclusters -h 2>/dev/null | grep -q "^${PG_MAJOR} "; then
  sudo pg_createcluster "${PG_MAJOR}" main --start
fi
sudo pg_ctlcluster "${PG_MAJOR}" main start 2>/dev/null || true

# Wait for Postgres to accept connections.
for _ in $(seq 1 30); do
  if sudo -u postgres psql -tAc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> Configuring postgres role and databases"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER USER postgres WITH PASSWORD 'postgres';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='buwiz-books'" | grep -q 1 \
  || sudo -u postgres psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "buwiz-books";'
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='buwiz-books-tests'" | grep -q 1 \
  || sudo -u postgres psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "buwiz-books-tests";'

echo "==> Writing .env files if absent (secrets generated locally, never committed)"
if [[ ! -f .env ]]; then
  AUTH_SECRET="$(openssl rand -base64 32)"
  ENC_KEY="$(openssl rand -base64 32)"
  cat > .env <<EOF
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/buwiz-books
DATABASE_URL_ADMIN=
MIGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/buwiz-books
MIGRATION_SCHEMA_SYNC_CONFIRM=buwiz-books
BETTER_AUTH_SECRET=${AUTH_SECRET}
BETTER_AUTH_URL=http://localhost:3000
INVITE_ONLY=false
ADMIN_EMAIL=
OTP_SKIP_EMAILS=ceo@goldcoders.dev
SECRETS_ENCRYPTION_KEY=${ENC_KEY}
RESEND_API_KEY=re_placeholder_dev_key
MAIL_FROM=invoices@example.com
JOB_DRAIN_MODE=inline
DEV_LOGIN_BYPASS=true
DEV_LOGIN_EMAIL=ceo@goldcoders.dev
DEV_LOGIN_EMAILS=ceo@goldcoders.dev
EOF
fi
if [[ ! -f .env.test ]]; then
  ENC_KEY="$(openssl rand -base64 32)"
  cat > .env.test <<EOF
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/buwiz-books-tests
MIGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/buwiz-books-tests
MIGRATION_SCHEMA_SYNC_CONFIRM=buwiz-books-tests
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/buwiz-books-tests
BETTER_AUTH_SECRET=test-secret-not-for-production
SECRETS_ENCRYPTION_KEY=${ENC_KEY}
DEV_LOGIN_BYPASS=true
DEV_LOGIN_EMAIL=ceo@goldcoders.dev
DEV_LOGIN_EMAILS=ceo@goldcoders.dev
EOF
fi

echo "==> Installing JS dependencies"
bun install --frozen-lockfile

echo "==> Building development database"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/buwiz-books" \
  bash "$REPO_ROOT/.cursor/setup-db.sh" --seed-app

echo "==> Building test database"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/buwiz-books-tests" \
  bash "$REPO_ROOT/.cursor/setup-db.sh" --seed-test

echo "==> Install complete"
