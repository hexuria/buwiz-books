# Buwiz Books — AI-native accounting platform

Multi-tenant double-entry accounting. Bun + TanStack Start (SSR) + Drizzle/Postgres, with
Postgres RLS as the tenant boundary. Runs on Neon (TCP) and Cloud Run + Cloud SQL (unix socket)
from the same image.

Use `bun`, never `npm`/`node`/`npx`.

If `rtk` is on your PATH you may prefix shell commands with it (`rtk git status`) to compress
output before it reaches context. It is a personal tool, not a project dependency — it is not in
`package.json`, the Dockerfile, or CI, and nothing here installs it, so skip the prefix when it is
absent rather than treating a missing `rtk` as an error.

## Invariants you can't infer from the file tree

**`src/routes/api/-*.ts` are not routes.** The `-` prefix excludes a file from TanStack Router's
generated tree; these are server-function modules imported by hooks and components. Real HTTP
endpoints live in `server/routes/` (Nitro: webhooks, inbound email, auth, internal workers).
`src/routeTree.gen.ts` is generated — never hand-edit it.

**Every DB access goes through an org-context wrapper.** RLS policies read Postgres session vars
(`app.current_organization_id`, `app.current_user_id`, `app.user_role`). These are set by
`withOrgContext` in [src/db/index.ts](src/db/index.ts). Request-scoped code never calls it
directly — it goes through one of the four wrappers in `src/lib/server-context.ts`, which resolve
the session and then delegate:

| Wrapper                                                        | Use for                                       |
| -------------------------------------------------------------- | --------------------------------------------- |
| `withSessionOrgContext`                                        | authenticated organization reads              |
| `withPermissionOrgContext(resource, action, …)`                | organization reads needing permission checks  |
| `withMutationSessionOrgContext(guard, …)`                      | organization writes                           |
| `withMutationPermissionOrgContext(resource, action, guard, …)` | organization writes needing permission checks |
| `withSessionUserContext`                                       | authenticated cross-organization user reads   |
| `withMutationSessionUserContext(scope, guard, …)`              | guarded cross-organization user writes        |

Use the `ctx.db` handed to the callback, not the module-level `db`.

Background code has no request, so it cannot use those wrappers — worker job handlers
(`src/lib/jobs/handlers/*`), the inbox service, and ingest triage call `withOrgContext(orgId, …)`
directly with an explicit org. That is correct, not a tenancy violation; the wrapper table above
covers request-scoped entry points only.

Every policy is written
`USING (current_organization_id() IS NULL OR organization_id = current_organization_id())`, so a
query issued outside a wrapper reads and writes across **all** organizations. Once the planned
hardening lands (dedicated `BYPASSRLS` admin role, `IS NULL` clause dropped) the same bug flips to
returning nothing instead. Both failure modes are silent — see the security note at the top of
[drizzle/rls_policies.sql](drizzle/rls_policies.sql).

`dbAdmin` bypasses RLS and is only for genuinely context-free paths (public invoice view, payment
capture webhooks). Adding a new caller needs a real justification.

**`bun run` does not expand `.env` into the `psql` package scripts.** `db:reset` and `db:rls` shell
out to `psql "$DATABASE_URL"`, and that variable arrives empty unless you export it — psql then
falls back to the database named after your OS user and operates on the _wrong_ database silently.
CI is unaffected because it sets `DATABASE_URL` as a real job env var. Both scripts now abort with
an explicit message instead; pass the URL yourself:
`DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" bun run db:rls`.

A full local rebuild is `db:fresh`, and it is now the complete path: `db:reset` drops the schema,
`db:migrate` runs one ordered pass over the whole manifest — Drizzle's journal, the pre-schema
migrations, schema synchronization, then the post-schema migrations — and `db:rls`, `db:seed`,
`db:seed:coa`, and `db:seed:review-rules` follow. The older warning that `db:fresh` skipped the
dedup migrations (CHECK constraints, tenant-lineage FKs, `pg_trgm`) no longer holds: those are
manifest entries `0019`-`0024` and the engine cannot skip them. Do **not** run `drizzle-kit push`
alongside `db:migrate`; synchronization is a lifecycle step the engine owns, and running it
separately puts it ahead of the pre-schema migrations that exist to keep it non-interactive.
`db:migrate` requires `MIGRATION_DATABASE_URL`, and because it synchronizes the schema it also
requires `MIGRATION_SCHEMA_SYNC_CONFIRM` set to the target database name. Run `db:rls` last — its
policy blocks are guarded by table-existence checks and silently skip tables that do not exist yet.

**The review-rule catalog is global, and a seeding step is only as good as the paths that call
it.** `review_rule_definitions` has no `organization_id` and is excluded from every RLS policy
list — one empty table means every tenant sees zero review agents. Its rows lived only inside
`drizzle/0019_inbox_review_foundation.sql`, which is absent from `drizzle/meta/_journal.json` and
so is never run by `drizzle-kit`; its only invoker back then was the since-removed
`db:dedup:migrate`, which the deploy pipeline did not call. (The ordered manifest now applies
0019 on every path, but the catalog's home has already moved.) Every environment therefore
created the table from the Drizzle schema and
left it empty, and the failure was silent: `/review-agents` simply reported that no agents were
configured. The catalog now lives in `src/lib/inbox/review-rule-catalog.ts` and is seeded from the
local `db:fresh` and `db:test:fresh` rebuilds, with `tests/unit/review-rules-wiring.test.ts`
asserting those links still exist. The unattached canonical deployment repository must own the
equivalent production seeding step. Use
`bun db:review-rules:status` to inspect any database read-only. Both modes print the database
they connected to first — an unset `DATABASE_URL` sends `psql` to the database named after your
OS user, where these tables are genuinely absent, which reads exactly like a real bug.

The seeder is `ON CONFLICT (key) DO NOTHING` and must stay that way: `0020` already rewrote
`possible_duplicate`'s `default_config`, and `loadDuplicateEngineConfig` reads mode and scores
straight off it, so a `DO UPDATE` would let an edit to a TypeScript constant retune duplicate
blocking for every tenant at deploy time with no version bump and no audit row. Changing an
existing definition is a reviewed numbered migration.

`db:seed:coa` applies a chart-of-accounts preset to ONE organization and is a thin wrapper over the
same applier the app uses (`src/lib/coa/`). It is idempotent and never deletes — accounts the org
already has are matched by number, then name, and reused. Pass `ORG_ID` (it otherwise picks the
first org in the table) and optionally `COA_PRESET`:
`ORG_ID=<org> COA_PRESET=saas_startup bun run db:seed:coa`. It previously ran
`DELETE FROM accounts` with no org predicate, which wiped every tenant's chart; do not reintroduce
a destructive path here.

**The chart of accounts and the category mappings are one system.** `src/lib/coa/presets/` owns the
account tree; the three `*-mapping-config.ts` files map domain keys (`default_expense`,
`accounts_payable`, …) onto it. Applying a preset guarantees every mapping row resolves — the
executor throws if one does not, so an org is either fully mapped or untouched. Server code must
resolve posting accounts through `src/lib/coa/resolve-mapped-account.ts`, never by scanning for a
hardcoded `subtype`: that is what left `category_mappings` write-only, with a fallback that could
post a bill line to Accounts Receivable.

**`guard` is not optional decoration.** `{ routeKey, limit?, windowMs? }` drives per-org rate
limiting. It's process-local (`src/lib/request-guards.ts`), so it does nothing across Cloud Run
replicas — don't treat it as the only defense on an expensive or destructive mutation.

**Money is strings, and float math is a bug.** Amount columns are `decimal(20,8)` and Drizzle
returns them as strings. Convert to integer minor units with `src/lib/money.ts`
(`moneyToCents` / `centsToMoney`) before arithmetic. Journal lines must balance to the cent.

**Query keys come from `src/lib/query-keys.ts`.** Inline key arrays split the cache silently, and
the hierarchy is what makes prefix invalidation work.

**Toolchain is Oxc.** `bun check` = `oxlint` + `oxfmt --check` + `tsc --noEmit`. Do not introduce
ESLint, Prettier, or Biome.

**Schema changes to exported entities have a protocol.** Adding, removing, or renaming a column on
a table in the export/import system without updating the version registry, migration engine, and
Zod validators causes silent data loss on import. Read
[.agent/rules/schema-export-import.md](.agent/rules/schema-export-import.md) before touching
`src/db/schema/`.

## Deeper references

Read these when the task calls for them — they are deliberately not imported.

- Domain model — [journal.md](internal-docs/architecture/journal.md),
  [ledger_types.md](internal-docs/architecture/ledger_types.md)
- Commands, migrations, deploy — [README.md](README.md)
- Test layout and env (`.env.test`; integration runs `--no-file-parallelism`) —
  [TESTING.md](TESTING.md)
- Inbox / inbound email — [docs/inbox-workflow.md](docs/inbox-workflow.md)
- Multi-provider AI work in flight — [AI_MULTIPROVIDER_PLAN.md](AI_MULTIPROVIDER_PLAN.md)

`.agent/rules/*` predate this file but are still authoritative for the protocols they cover, so
they are linked above rather than duplicated here.

## Working here

Match the surrounding file — import style is mixed (`@/…` alias and relative paths both appear),
so follow the module you're editing rather than converting it.

This is accounting software: correctness of money, period boundaries, and the org boundary
outranks everything else. When a change touches balances, tenancy, or auth, prefer the explicit
version over the clever one, and say plainly when something is unverified.

`bun check` must pass clean before work is done. Run the test tier that matches what you changed —
the full E2E suite resets the test database.
