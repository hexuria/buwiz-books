#!/usr/bin/env bash
# Cloud Agent start: per-boot service reconciliation.
#
# Runs on every boot (the install snapshot preserves files, not processes). Its
# only job is to make sure the local Postgres cluster is accepting connections
# before the agent and the dev server need it.
set -euo pipefail

PG_MAJOR=16

sudo pg_ctlcluster "${PG_MAJOR}" main start 2>/dev/null || true

for _ in $(seq 1 30); do
  if sudo -u postgres psql -tAc 'SELECT 1' >/dev/null 2>&1; then
    echo "Postgres ${PG_MAJOR} is ready."
    exit 0
  fi
  sleep 1
done

echo "Postgres ${PG_MAJOR} did not become ready in time." >&2
exit 1
