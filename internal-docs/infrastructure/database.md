# Database Operations

All database commands for local development and production.

---

## Local Development

### Quick Setup

```bash
# Full reset: drop all → push schema → seed superuser
bun fresh

# Start Drizzle Studio (visual DB browser)
bun db:studio
```

### Schema Changes

```bash
bun db:push          # Push schema to local DB (no migration files)
bun db:generate      # Generate migration from schema diff
bun db:migrate       # Apply pending migration files
```

> **`db:push` vs `db:generate + db:migrate`:** Use `db:push` during active development for speed. Use `db:generate` + `db:migrate` when you need version-controlled migration files.

### Reset

```bash
bun reset            # Drop all tables and re-push schema
bun fresh            # reset + seed superuser (clean slate)
```

### Seeders

```bash
bun seed                               # Seed superuser + organization
bun run scripts/seed-coa.ts            # Chart of Accounts (70+ categories)
bun run scripts/seed-invoices.ts       # Sample invoices
bun run scripts/seed-documents.ts      # Sample documents
bun db:seed:review-rules               # Review agent catalog (16 rules, global)
bun db:review-rules:status             # Read-only: inspect that catalog
```

> **Note:** `bun fresh` only seeds the superuser. Run other seeders separately as needed.

#### The review-rule catalog is different from the others

Every seeder above writes rows scoped to one organization. `db:seed:review-rules`
writes to `review_rule_definitions`, which has **no `organization_id`** and is
excluded from every RLS policy — a single empty table means every tenant sees
zero review agents and `/review-agents` renders as if nothing were configured.

It is idempotent and strictly additive (`ON CONFLICT (key) DO NOTHING`), so it is
safe to run against any database at any time, and it never modifies a definition
that already exists. That last part is load-bearing: migration `0020` rewrote
`possible_duplicate`'s `default_config`, and the duplicate engine reads mode and
scores straight off it, so an `ON CONFLICT DO UPDATE` would let an edit to a
TypeScript constant retune duplicate blocking for every tenant at deploy time.
Changing an existing definition is a reviewed numbered migration, not a seed.

Unlike the other seeders it is wired into `db:fresh`, `db:test:fresh`, the deploy
workflow and `make migrate`; `tests/unit/review-rules-wiring.test.ts` fails if any
of those links is removed.

---

## Production requirements (canonical deployment repository)

This application repository does not own the production deployment path. The
separate canonical deployment repository must verify the historical Cloud SQL
target assumptions recorded here. Do not use the legacy `db-prod`/`rls-prod`
Neon helpers or credentials from another deployment.

There are two database credentials:

| Secret               | Role                    | Use                                                  |
| :------------------- | :---------------------- | :--------------------------------------------------- |
| `database-url`       | non-owner `app_runtime` | Cloud Run application queries under RLS              |
| `database-url-admin` | `buwiz_books_admin`     | schema/RLS migrations and explicit operator commands |

For local validation only, the historical target-guarded helper is:

```bash
make migrate
```

The canonical deployment tooling must preserve the same dependency order. The
local helper runs AI foundation, schema reconciliation, Enterprise migrations `0028`
through `0036`, integrity migration, RLS policies, runtime grants, and the
review-rule catalog in dependency order. The local helper's target guards do not
prove the current production boundary or live deployment state.

> [!WARNING]
> The current reconciliation step still uses `drizzle-kit push --force`, which
> can apply destructive schema differences. Review the generated schema diff,
> take a target backup, and use a protected production deployment environment
> before approving it. The numbered Enterprise migrations themselves are
> checksum-fenced and must never be edited after application.

After migration, verify:

1. `app_manual_migrations` contains `0028` through `0036` with the nine expected checksums;
2. `app_runtime` has DML/function grants but does not own application tables;
3. the Cloud Run service mounts `database-url` as `DATABASE_URL` and the separate
   admin secret only as `DATABASE_URL_ADMIN`;
4. cross-organization RLS integration tests pass; and
5. projection state/backfill checks pass before enabling a Business Group canary.

---

## Backup & Restore

### Create a Backup

```bash
source .env && pg_dump --data-only --inserts --column-inserts \
  --no-owner --no-privileges "$DATABASE_URL" \
  -f scripts/backup-$(date +%Y-%m-%d).sql
```

### Restore from Backup

```bash
bash scripts/restore-backup.sh
```

The restore script will:

1. Apply the latest schema with `drizzle-kit push`
2. Truncate all data tables
3. Restore data from the backup file

> [!WARNING]
> Backups contain sensitive auth tokens and are git-ignored via `scripts/backup-*.sql`. Never commit them.

---

## Drizzle Studio

Visual database browser for inspecting and editing data:

```bash
bun db:studio
```

Opens at `https://local.drizzle.studio` — works with both local and production databases (set `DATABASE_URL` accordingly).

---

## Troubleshooting

### Connection errors

- Verify the service has the exact Cloud SQL attachment
  `buwiz-503321:europe-north1:buwiz-books-db`.
- Runtime socket URLs must use `host=/cloudsql/<connection-name>`; TLS is local
  to the mounted socket and is intentionally disabled by `createQueryClient`.
- Operator/CI migrations must run through Cloud SQL Auth Proxy and the admin
  secret. Never expose a public password URL or add broad authorized networks.

### Schema push fails

- Run `bun db:generate` first to see the diff
- Check for data that conflicts with new constraints
- For enum changes, you may need to manually migrate (see [Drizzle enum docs](https://orm.drizzle.team/docs/column-types/pg#enum))

### RLS policy errors

- Ensure migrations use `database-url-admin`, not the non-owner runtime URL.
- Check `drizzle/rls_policies.sql` for syntax errors
