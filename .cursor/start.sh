#!/usr/bin/env bash
# Cloud Agent start: per-boot service reconciliation.
#
# Runs on every boot (the install snapshot preserves files, not processes). Its
# only job is to make sure the local Postgres cluster is accepting connections
# before the agent and the dev server need it.
set -euo pipefail

PG_MAJOR=16
DATA_DIR="/var/lib/postgresql/${PG_MAJOR}/main"

is_ready() { sudo -u postgres psql -tAc 'SELECT 1' >/dev/null 2>&1; }

# A snapshot taken while Postgres was running leaves a stale postmaster.pid that
# points at a PID which no longer exists after the reboot. Clear it before
# starting so pg_ctlcluster does not refuse to start the cluster.
if ! is_ready && sudo test -f "${DATA_DIR}/postmaster.pid"; then
  echo "Clearing stale postmaster.pid"
  sudo rm -f "${DATA_DIR}/postmaster.pid"
fi

sudo pg_ctlcluster "${PG_MAJOR}" main start 2>/dev/null || true

for _ in $(seq 1 30); do
  if is_ready; then
    echo "Postgres ${PG_MAJOR} is ready."
    exit 0
  fi
  sleep 1
done

echo "Postgres ${PG_MAJOR} did not become ready in time." >&2
exit 1
