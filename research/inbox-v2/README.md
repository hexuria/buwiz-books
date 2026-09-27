# Inbox v2: routines, Jev, rule packs, memory

Status: research and design only. No code in this branch. Base: `v2` at `b736189`.
Date: 2026-09-27. Revision 2: consolidated a seven-angle review (UI/UX, ingestion, posting
correctness, Jev and evals, rules and autonomy, security, rollout). Per-angle findings and the
verdict on each disputed claim are in [`review-findings.md`](review-findings.md).

`visual.html` in this folder is the plain-language picture of the same plan (open it in a
browser). This file is the version an agent builds from.

Hosted version of the visual: https://claude.ai/artifact/BBTTrkBY51kpdRTEyRkvib (private;
the owner shares it from the page's Share menu). If the two copies differ, the hosted page is the
newer one.

## Principle

The ledger works without the Inbox. The Inbox only automates typing. What it saves must equal
what a human would save in the existing editors, through the same domain code. Never bend ledger
invariants (balance to the cent, period locks, tenancy, audit) to fit the Inbox. Every failure
degrades to "Needs you", never to wrong books.

Letting Jev approve changes **AI authority** (who may press the button), not a ledger rule. The
posting that follows is identical to a human's.

## Goal

A simple inbox where source documents are ingested automatically, classified with high accuracy
by Jev, checked by versioned rules, and approved by Jev (once earned) or a human. Human
corrections stick deterministically. Every change to rules or models is measurable before it
ships.

```text
routine fires (webhook | schedule | integration later)
  -> save raw paper -> OCR text (Gemini) -> redaction
  -> memory match? yes: deterministic answer
                   no:  Jev (+ approved lessons), closed lists only
  -> pinned rule snapshot checks the draft
  -> Jev approves (earned lane, not sampled) OR Inbox "Needs you"
  -> approve = shared posting core (same code the editors use) -> books
```

## What already exists on `v2` (keep, do not rewrite)

| Piece                                                                                                                                                               | Where                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Event, job queue, source records, candidates + lines, inbox items, findings, decisions, workflow events                                                             | `src/db/schema/inbox.ts`                                                           |
| Job leases: `FOR UPDATE SKIP LOCKED`, 5-min lease, worker-id fenced completion, 8 attempts, backoff                                                                 | `src/lib/inbox/processing-job-lease.ts`, `src/lib/jobs/registry.ts`                |
| Production drain: fire-and-forget POST to `/api/internal/worker` with `INBOX_WORKER_SECRET`; silently no-ops if the secret is unset (startup logs an error)         | `src/lib/jobs/trigger.ts`, `server/plugins/job-drain.ts`                           |
| Connection, source, sync-run tables with `next_sync_at` and `sync_cursor`. **No application code reads them.**                                                      | `src/db/schema/inbox.ts`                                                           |
| Only real ingest webhook: Resend inbound email, Svix signature verified, multi-org recipients, `providerEventId` dedupe                                             | `server/routes/api/inbound-email/resend.post.ts:41-66, 75-87, 133`                 |
| Model chain router, Gemini first; provider enum; pricing; per-org spend cap (process-local 60s cache)                                                               | `src/lib/ai/chains.ts`, `src/lib/ai/errors.ts:28`, `pricing.ts`, `spend.ts`        |
| OCR tasks are Gemini-only (redaction cannot clean document bytes); text tasks go through a `RedactedPrompt` type                                                    | `src/lib/ai/chains.ts` header, `src/lib/ai/redact.ts`                              |
| Mock AI runtime for deterministic tests (`AI_MODE=mock`)                                                                                                            | `docs/ai-mock.md`                                                                  |
| Earned autonomy: 200 reviewed at >= 98% to unlock, auto-demote < 95% over last 50, admin-only promotion; stored per **kind** in `organization_ai_settings.autonomy` | `src/lib/ai/autonomy.ts`, `src/db/schema/ai.ts:248`                                |
| Hard wall: `match`, `split`, `coa_accounts`, `create_party`, `date_fix`, `categorize` never model-applied                                                           | `STRUCTURAL_MANUAL_KINDS`, `src/lib/ai/autonomy.ts:31-44`                          |
| Maker-checker for humans: `requireDifferentApprover`                                                                                                                | `src/lib/inbox/service.ts:887`                                                     |
| Corrections -> reflection -> proposed lessons (admin-approved, max 10 / 2000 chars, injected as data)                                                               | `ai_run_feedback`, `src/lib/jobs/handlers/reflection.ts`, `src/lib/ai/lessons.ts`  |
| Corrections -> eval cases; recorded evals with code graders (money compared in cents)                                                                               | `scripts/build-eval-dataset.ts`, `tests/evals/`                                    |
| Vendor aliases (normalized descriptor -> party); `pg_trgm` installed                                                                                                | `src/lib/match-assist/aliases.ts`, `drizzle/0027_vendor_aliases.sql`               |
| Rule catalog 13 book + 2 system; inbox book rules read **live per-org** `review_rule_configs` (enabled, impact, thresholds)                                         | `src/lib/inbox/review-rule-catalog.ts`, `src/lib/inbox/service.ts:730-754`         |
| Uncategorized accounts in every preset; `default_expense` -> `uncategorized_expense`; `uncategorized` rule is blocking                                              | `src/lib/coa/presets/base.ts`, `base-mappings.ts`, `src/lib/inbox/rules.ts:61-72`  |
| Entity resolver is match-only, exact `ilike`; unmatched -> `create_party` proposal                                                                                  | `src/routes/api/-ai-entity-resolver.ts`                                            |
| **Amend-by-reversal**: original stays posted, reversal row points back via `reversesHeaderId`                                                                       | `src/lib/journal-amendment.ts`                                                     |
| Void sets `status = 'voided'`; reports are as-of aware of `voided_at`                                                                                               | `src/routes/api/transactions/-_mutations.ts:342`, `src/routes/api/-reports.ts:170` |
| Exact decimal money for candidates: bigint at 8 decimals                                                                                                            | `src/lib/inbox/money.ts`                                                           |
| Env-var product flag pattern                                                                                                                                        | `src/lib/tax/product-flag.ts`                                                      |
| Export/import registry, version 4                                                                                                                                   | `src/lib/export-versions.ts`, `.agent/rules/schema-export-import.md`               |
| Existing editors: Bills, New transaction (Journal / Pay in / Pay out / Transfer), invoice drafts                                                                    | `src/routes/bills_.create.tsx`, `transactions_.new.tsx`, invoice draft routes      |

### Problems found while grounding

1. **Emailed and uploaded bills never become bill records.** Email candidates are
   `email_transaction` (`resend.post.ts:264`, `jobs/handlers/inbound-email.ts:669`), uploads are
   `document_transaction` (`document-intake.ts:512`). `approveInboxItem` touches `bills` only when
   `candidateType === "bill"` and a bill already existed (`service.ts:1203-1214`). Such bills are
   posted to the journal but missing from Bills and payables aging.
2. **Editors cannot be reused as-is.** They navigate on success (`bills_.create.tsx:123-127`) and
   their saves are `createServerFn` wrapped in `withMutationPermissionOrgContext`, which needs a
   user session. A background Jev approval has none.
3. **No way to record a non-human approver.** `review_decisions.actor_id` is `NOT NULL` FK to
   `user` (`schema/inbox.ts:750+`). `approveInboxItem` writes `createdBy: userId`.
4. **Inbox findings depend on Review Agents config.** Removing that page before moving its config
   leaves enable/impact/thresholds editable only in the database.
5. **Bills store 2 decimals, candidates 8.** `bills.amount` is `decimal(15,2)`; journals are
   `decimal(20,8)`. Creating a bill from a candidate needs an explicit cent policy (reject
   sub-cent, never silent DB rounding).
6. **No tax columns on bills.** `postBillAccrualJournal` (`src/lib/bill-journal.ts`) posts expense
   - AP only. PH withholding / VAT on inbox bills is unhandled.
7. **Silent dedupe.** `processing_jobs` dedupe is a partial unique on queued/running only; a
   suppressed insert logs nothing. A second fire after completion runs again.
8. **Stale comment.** `src/lib/entity-creation.ts:210` says `create_party` can run unattended. It
   is now structurally manual.
9. **Confidence trap.** `normalizeConfidence` reads a bare `1` as 1% unless the scale is pinned.
   `ingest_triage` already pins 0..1; every Jev schema must too.
10. **Current Inbox UI**: 1,866 lines, six overlapping filters, email setup in the rail, its own
    inline entry editor. Review Agents: 1,429 lines.

## Decisions (owner-confirmed)

- Inbox shows only what needs a human. No Done folder.
- Reading pane = the existing editor, prefilled. Approve uses the same save code.
- Jev may approve, through earned autonomy.
- Human fixes stick at 100% for the same paper (memory layer before any model).
- Jev handles category choice and entity matching.
- Categories: chart required before routines run. No fit -> Uncategorized.

## Design

### 1. Posting core (new foundation)

Extract session-free domain functions that the editors' server functions, inbox approval, and Jev
all call:

- `createBillCore(db, orgId, actor, draft)` -> bill row + accrual journal
- `postTransactionCore(db, orgId, actor, draft)` for journal / pay in / pay out / transfer
- `createInvoiceCore(db, orgId, actor, draft)`

Each takes an explicit `actor: { type: "user", userId } | { type: "system", key: "jev" }`.
Permission checks stay in the server-function wrappers for users; system actors are authorized by
the autonomy lane, not by a role. Existing invariants run inside the core: balance to the cent,
`isDateInLockedPeriod`, idempotency key, `resolve-mapped-account`. The server functions become
thin wrappers, so UI and inbox cannot drift.

`approveInboxItem` then calls the core for the classified kind and links the result through
`ledger_source_links`. This fixes problem 1 for the old UI too, so it can ship early.

Cent policy: candidate amounts are exact at 8 decimals; any kind that lands in a 2-decimal table
rejects sub-cent values with a blocking finding.

### 2. Actor model

- `review_decisions`: add `actor_type` (`user | system`) and `actor_key` (`jev`); make `actor_id`
  nullable with a check: `actor_type = 'user'` requires `actor_id`.
- Journals and bills created by Jev carry the system actor in their audit/activity rows.
- If `requireDifferentApprover` is on, Jev auto-approval is off unless an admin explicitly opts in.
- Every system approval writes an activity log row naming the lane, confidence, and rule snapshot.

### 3. Routines (how papers get in)

```sql
routines (
  id uuid pk, organization_id text not null fk cascade,
  name varchar(255) not null, enabled boolean not null default true,
  trigger_kind varchar(32) not null,            -- webhook | schedule | integration
  trigger_config jsonb not null default '{}',   -- see below
  rule_snapshot_id uuid,                        -- pinned rules (section 6)
  max_concurrent_runs int not null default 1,
  cursor text, next_run_at timestamptz, last_run_at timestamptz, last_error text,
  created_by text fk user, created_at, updated_at
)
-- index (organization_id, enabled, next_run_at) where trigger_kind = 'schedule' and enabled
processing_jobs.routine_id uuid null fk routines on delete set null
```

- `trigger_config`: webhook `{ auth: "hmac_sha256", secret_ref, tolerance_s: 300, max_bytes }`;
  schedule `{ preset: "hourly" | "daily" | "weekly", at: "06:00", timezone }`;
  integration `{ connection_id }`.
- **Schedules use presets, not free cron.** No cron dependency exists; presets cover the need.
  The existing drain (triggered by Cloud Scheduler hitting the worker endpoint) claims due routines
  with `SKIP LOCKED` on `next_run_at <= now()`, computes the next time, and enqueues jobs.
- **Webhook auth**: HMAC-SHA256 over timestamp + body, per-routine secret stored by reference,
  5-minute tolerance, `provider_event_id` dedupe, body size cap, verification before any insert.
- **Dedupe**: unique `(organization_id, routine_id, provider_event_id)` on `ingestion_events`; a
  suppressed duplicate writes a `workflow_events` row instead of vanishing.
- **Cursor** advances after the raw paper is saved, not after classification; handlers are
  idempotent, so a crash re-fetches and dedupes.
- Background handlers run in `withOrgContext(routine.organization_id, …)` read from the routine
  row, never from job payload alone.
- Missing `INBOX_WORKER_SECRET` in production must fail startup, not log.
- Inbound email becomes the first webhook routine. Enabling any routine requires an applied chart.

### 4. Jev (classification)

- Add `jev` to the provider enum (`src/lib/ai/errors.ts`), an adapter in `src/lib/ai/adapters/`,
  pricing rows, provider health, credentials, mock-runtime responses, and recorded eval fixtures.
- First hop for `ingest_triage` and `classify_document`; Gemini stays the fallback.
- Jev reads **redacted OCR text** built through `RedactedPrompt`. Never document bytes unless the
  owner changes the Gemini-only OCR decision.
- Sending data to Jev requires a per-org opt-in (new provider allowlist in
  `organization_ai_settings`), because it is a new data processor.
- **Two-stage classification**: stage 1 picks document kind; stage 2 picks accounts from the
  org's leaf accounts (about 110-150 per preset) passed as compact codes in a closed enum. If Jev's
  structured output cannot take that enum, fall back to top-k retrieval then choose.
- Output schemas pin confidence to 0..1.
- **Calibration, not raw confidence.** Thresholds come from a per-lane reliability table
  (confidence bucket -> observed accuracy from the org's own history). Settings shows it.
- No fit -> `uncategorized_expense` via `resolve-mapped-account`; blocking finding.
- Unverified: Jev's API, limits, latency, pricing, data residency, DPA.

### 5. Entities (vendors and customers)

1. Exact: TIN, sender email, `vendor_aliases`, memory.
2. Look-alikes: `pg_trgm` top 5 parties.
3. Jev picks one or says "new".
4. New: draft `create_party`; created with the approved entry via `entity-creation.ts`.

New parties always need a human (wall stays). **A document that changes a known party's bank or
payment details always needs a human**, regardless of lane. That is the classic invoice fraud path.

### 6. Rule snapshots (rules that can grow)

`review_rule_configs.version` is per row and old versions are not kept, so it cannot serve as a
pack. Use a small immutable snapshot table, following the `config_snapshot` pattern already on
`review_rule_runs`:

```sql
rule_snapshots (id uuid pk, organization_id text not null, label text,
                snapshot jsonb not null,  -- [{ruleKey, enabled, impact, config, formulaVersion}]
                created_by text, created_at)
```

- Routines pin `rule_snapshot_id`. The candidate path evaluates against the pinned snapshot
  instead of reading live configs (`service.ts:730`).
- Flow: create snapshot -> replay on the practice pile -> shadow on live papers (findings logged,
  not shown) -> promote by repinning -> older snapshot kept for rollback.
- Global catalog changes remain reviewed numbered migrations.

### 7. Memory (human fixes stick)

```sql
classification_memories (
  id uuid pk, organization_id text not null,
  match_kind varchar(32) not null,   -- file_hash | sender_party | party | line_text
  match_key varchar(255) not null,   -- normalized at write time (reuse alias normalization)
  answer_doc_kind varchar(32), answer_party_id uuid fk parties,
  answer_lines jsonb,                -- [{lineMatch, accountId, taxCode}]
  created_by text not null, source_feedback_id uuid,
  uses int not null default 0, undos int not null default 0,
  consecutive_undos int not null default 0, enabled boolean not null default true,
  created_at, updated_at,
  unique (organization_id, match_kind, match_key)
)
```

- Lookup order: memory -> Jev (+ lessons) -> rule snapshot. A hit answers with no model on the
  answer path. Jev runs in shadow only when the scorecard is sampling.
- A memory hit is still a draft: rules still run, blocking findings still block.
- **Permission**: only roles that can post entries may save a memory; memories that set accounts
  on more than a single party are admin-only. A memory never sets bank details.
- "Remember this?" is opt-in after a correction, with a scope picker and a replay count ("would
  have changed N past papers"; bounded to the last 12 months).
- Conflicting memories -> Needs you. `consecutive_undos >= 2` -> disabled in code and surfaced.
- Each saved memory writes an `ai_eval_cases` row (`provenance: authored`). Replay must reproduce
  it exactly or CI fails (test lock).

### 8. Jev approval (earned autonomy)

Per-kind autonomy cannot express per-vendor lanes, and `ai_run_feedback` has no lane fields.

```sql
ai_autonomy_lanes (
  id uuid pk, organization_id text not null,
  lane_key varchar(64) not null,        -- 'inbox_approve'
  party_id uuid null, doc_kind varchar(32) null,
  level varchar(16) not null default 'watch',   -- watch | suggest | auto
  amount_cap numeric(20,8), promoted_by text, promoted_at, demoted_at,
  unique (organization_id, lane_key, party_id, doc_kind)
)
ai_run_feedback.lane_id uuid null fk ai_autonomy_lanes   -- + index (organization_id, lane_id, created_at)
```

- Promotion admin-only, same `AUTONOMY_CRITERIA`, computed over that lane's feedback.
  Auto-demote the same way. Per-org kill switch.
- Auto-approve only if all hold: lane `auto`; calibrated confidence >= threshold; no open blocking
  finding; no duplicate case; known party; no bank-detail change; open period; amount <= cap;
  lines balance; not sampled.
- **Spot check = hold-back, not recall.** At decision time, a sample (default 10%) of items Jev
  would auto-approve is not posted; it goes to Needs you as "Spot check". The human decision is an
  unbiased label and nothing has to be reversed.
- Undo on an auto-approved entry = `journal-amendment` reversal (reversal only), plus bill void
  where relevant. Counts as a disagreement for the lane.
- Lifting `categorize` for `inbox_approve` is its own reviewed PR with tests.

### 9. Scorecard (testing)

```text
bun eval:scorecard --pile <org-id|golden> --chain default,jev --rules <snapshot-id> --json
```

Outputs: real problems caught, false alarms, approved with zero edits, Jev approvals a human would
undo, memory hit rate, locked cases passing (must be 100%), cost per 100 papers. Recorded mode
replays stored Jev responses so CI costs nothing; live runs are nightly with a budget cap. CI gate:
locked cases 100%.

### 10. Inbox screen

- Server-side list: open states + `failed` only. Badge count = that list's size.
- Reason chips: `needs_fix | jev_unsure | spot_check | failed`.
- Row: who, kind, relative date, amount, one chip.
- Pane: extracted editor components taking `draft` and `onSubmit` props (the routes wrap the same
  components). Desktop side pane; below `lg` a full-height drawer.
- Thin strip: reason, Remembered / Jev + confidence, Approve, Reject, "Remember this?", duplicate
  warning when present.
- Keyboard: `j`/`k` move, `a` approve, `r` reject, `e` focus editor. Optimistic removal and
  auto-advance to the next item.
- Approve invalidates `inbox`, `bills`, `transactions`, `invoices` key prefixes.

| Classified as                              | Editor component                   | Core                  |
| ------------------------------------------ | ---------------------------------- | --------------------- |
| Vendor bill                                | Bills editor (viewer + line items) | `createBillCore`      |
| Paid expense / money in / transfer / other | New transaction tabs               | `postTransactionCore` |
| Sales invoice                              | Invoice draft editor               | `createInvoiceCore`   |

- Saved entries show a "by Jev" / "remembered" tag. Rejected sources stay in Documents.
- Settings: Routines, Rules (enable, stop vs warn, thresholds, snapshots), Scorecard, Jev lanes
  (level, calibration, cap, history), ledger scan button.

### 11. Rollout

- Org-level flag `inbox_v2` (org metadata, not env var) so old and new coexist per org. Both read
  the same tables, so open items carry over with no data migration.
- New tables get RLS policies in `drizzle/rls_policies.sql` using the standard clause, and numbered
  migrations after the current highest (0052 at time of writing).
- Export/import: `routines`, `rule_snapshots`, `classification_memories`, `ai_autonomy_lanes` are
  org configuration and join export as a version-5 bump per the protocol.
- Docs: `docs/inbox-workflow.md`, user docs under `docs/`, CLAUDE.md wrapper notes for system
  actors.

## Build order (one PR each, base `v2`)

| #   | Step                                                                                                                               | Done when                                                                      | Tests                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | Move rule config to Settings                                                                                                       | enable/impact/thresholds editable in Settings; inbox findings unchanged        | unit + E2E Settings                                                 |
| 2   | Hide Review Agents, redirect, ledger-scan button                                                                                   | no sidebar entry; `/review-agents` -> `/inbox`                                 | E2E redirect                                                        |
| 3   | Posting core + actor model + cent policy                                                                                           | editors and `approveInboxItem` call the cores; emailed bill creates a bill row | integration: bill from email appears in Bills; balance; period lock |
| 4   | Routines + email as webhook routine + dedupe events + RLS                                                                          | email flows through a routine; duplicate logged                                | integration dedupe, RLS                                             |
| 5   | Schedule presets via drain                                                                                                         | due routines fire once; double run makes no duplicates                         | integration with fake clock                                         |
| 6   | Jev provider (blocked on API)                                                                                                      | recorded fixtures pass; redaction enforced; opt-in required                    | evals recorded, unit adapter                                        |
| 7   | Category + entity checks                                                                                                           | chart gate; closed enum; Uncategorized blocks; pg_trgm + Jev match             | unit + integration                                                  |
| 8   | Rule snapshots + replay + scorecard + CI gate                                                                                      | one command prints the metrics                                                 | integration with fixture pile                                       |
| 9   | New Inbox screen behind `inbox_v2`                                                                                                 | spec'd list, pane, keyboard, invalidation                                      | component + E2E with `AI_MODE=mock`                                 |
| 10  | Memory + "Remember this?"                                                                                                          | same paper -> same answer, no model; locked case written                       | unit collisions/undo, eval lock                                     |
| 11  | Jev lanes watch -> suggest -> auto, hold-back spot check, reversal undo, kill switch; separate PR lifts `categorize` for this lane | per-lane metrics on scorecard; demotion works                                  | integration autonomy                                                |
| 12  | Cutover: flag default on, remove old inbox, export v5, docs                                                                        | old page gone; export round-trips new tables                                   | E2E, export/import                                                  |

Step 3 is valuable alone: it fixes missing bill records in today's Inbox.

## Rules for the building agent

- Request code uses the org-context wrappers in `src/lib/server-context.ts`; background code uses
  `withOrgContext(orgId, …)` with the org read from the owning row.
- Money via exact decimal helpers; journal lines balance to the cent.
- Query keys from `src/lib/query-keys.ts`.
- Read `.agent/rules/schema-export-import.md` before adding tables.
- Posting accounts via `src/lib/coa/resolve-mapped-account.ts`.
- `bun check` passes. Run the test tier matching the change.

## Open questions

- Jev: API shape, enum size limits, latency, pricing, data residency, DPA.
- Whether Jev may ever read document bytes.
- PH withholding / VAT on inbox bills: out of scope for v2, or part of the bill core?
- Default amount cap and spot-check rate (fixed 10% or decaying with lane accuracy).
- Period close: should open inbox items for a period block or only warn at close?
- Integration routines: which first provider, and whether `integration_connections` is reused.
