# Database Operations

Local-development commands and the production database contract. No command in
this application document is authorized for production.

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

It is idempotent and strictly additive (`ON CONFLICT (key) DO NOTHING`), and it
never modifies a definition that already exists. That last part is load-bearing:
migration `0020` rewrote `possible_duplicate`'s `default_config`, and the duplicate
engine reads mode and scores straight off it, so an `ON CONFLICT DO UPDATE` would
let an edit to a TypeScript constant retune duplicate blocking for every tenant at
deploy time.
Changing an existing definition is a reviewed numbered migration, not a seed.

Unlike the other seeders it is wired into the local `db:fresh` and `db:test:fresh`
rebuilds. `tests/unit/review-rules-wiring.test.ts` guards those links. The
unattached canonical deployment repository must own production seeding.

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

The historical `make migrate` entry point is disabled here. The canonical
deployment tooling must preserve the recorded dependency order: AI foundation,
schema reconciliation, Enterprise migrations `0028` through `0036`, integrity
migration, RLS policies, runtime grants, and the review-rule catalog. That order
is historical evidence, not authorization to run application-repository tools
against a non-local database.

> [!WARNING]
> The historical reconciliation design used `drizzle-kit push --force`, which
> can apply destructive schema differences. It is not runnable through the
> disabled application Make target. Canonical deployment must replace or fence
> that behavior, review every schema change, and prove backup/restore readiness
> before approval. Numbered migrations must never be edited after application.

After migration, verify:

1. `app_manual_migrations` contains `0028` through `0036` with the nine expected checksums;
2. `app_runtime` has DML/function grants but does not own application tables;
3. the Cloud Run service mounts `database-url` as `DATABASE_URL` and the separate
   admin secret only as `DATABASE_URL_ADMIN`;
4. cross-organization RLS integration tests pass; and
5. projection state/backfill checks pass before enabling a Business Group canary.

---

## Backup & Restore

Backup, restore, and restore rehearsal are owned by the canonical deployment
repository. The historical `scripts/restore-backup.sh` is fail-closed because it
could truncate the database selected by ambient `DATABASE_URL`. Do not copy its
unreachable implementation into an operator shell.

> [!WARNING]
> Backups contain sensitive auth tokens and are git-ignored via `scripts/backup-*.sql`. Never commit them.

---

## Drizzle Studio

Visual database browser for inspecting and editing data:

```bash
bun db:studio
```

Opens at `https://local.drizzle.studio`. Use it only with an explicitly selected
local development database; it is not an authorized production console.

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
