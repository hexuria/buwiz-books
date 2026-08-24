#!/usr/bin/env bash
# Build a Buwiz Books database from scratch using the repository's proven
# schema-application recipe.
#
# This mirrors what CI and onboarding do (see .github/workflows/deploy.yml and
# the comments in scripts/migrate.ts): `drizzle-kit push --force` is this
# repository's schema application. The managed `db:migrate` lifecycle is for
# real databases applied incrementally and its post-schema verifiers reject a
# freshly-pushed base by design, so it is not used to bootstrap dev/test DBs.
#
# Idempotent: it drops and recreates the public schema, so re-running converges
# to the same seeded state.
#
# Usage: DATABASE_URL=... .cursor/setup-db.sh [--seed-app|--seed-test]
#   --seed-app   (default) seed superuser + chart of accounts + review rules
#   --seed-test  seed superuser + review rules + e2e transaction snapshot
set -euo pipefail

MODE="${1:---seed-app}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set" >&2
  exit 1
fi

export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/.."

echo "==> Resetting schema on ${DATABASE_URL%%\?*}"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

echo "==> Pushing Drizzle schema"
bun x drizzle-kit push --force >/dev/null

echo "==> Applying Enterprise business-group migrations (0028-0036)"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -c \
  'ALTER TABLE IF EXISTS organization_group_entities ADD COLUMN IF NOT EXISTS parent_entity_id uuid;'
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction \
  -f drizzle/0028_enterprise_business_groups.sql
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -c '
  ALTER TABLE IF EXISTS organization_group_entities
    DROP CONSTRAINT IF EXISTS organization_group_entities_account_group_fk;
  DROP INDEX IF EXISTS organization_group_entities_account_org_enabled_unique;
  ALTER TABLE IF EXISTS organization_group_entities
    DROP COLUMN IF EXISTS enterprise_account_id;
  ALTER TABLE IF EXISTS organization_groups
    DROP CONSTRAINT IF EXISTS organization_groups_account_id_unique;'
for file in 0029_business_group_entity_exclusivity \
            0030_business_group_assignment_probe \
            0031_flat_business_group_entities \
            0032_reporting_projections \
            0033_projection_reconciliation \
            0034_business_group_admin_guards \
            0035_enterprise_stripe_billing \
            0036_enterprise_checkout; do
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 --single-transaction -f "drizzle/${file}.sql"
done

echo "==> Applying RLS policies"
psql "$DATABASE_URL" -q -f drizzle/rls_policies.sql

echo "==> Applying RLS hardening (Section A)"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f drizzle/rls_hardening.sql

case "$MODE" in
  --seed-app)
    echo "==> Seeding superuser, chart of accounts, review rules"
    bun run scripts/seed-superuser.ts
    bun run scripts/seed-coa.ts
    bun run scripts/seed-review-rules.ts
    ;;
  --seed-test)
    echo "==> Seeding superuser, review rules, e2e transaction snapshot"
    bun run scripts/seed-superuser.ts
    bun run scripts/seed-review-rules.ts
    bun run tests/e2e/seed-snapshot.ts
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac

echo "==> Database ready"
