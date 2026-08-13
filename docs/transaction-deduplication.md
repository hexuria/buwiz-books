# Transaction deduplication operations

The deduplication invariant is one effective posted journal per economic event
without deleting its source evidence. Emails, receipts, provider objects,
documents, reviewer decisions, and both original journals remain auditable.

## What is deduplicated

Three boundaries are intentionally separate:

- **Request/provider replay** returns the existing logical source or candidate.
  Manual and bill submissions reuse a caller-generated idempotency key, and a
  provider object is unique by organization, source, and external object ID.
- **Document reuse** stores identical bytes once per organization and reuses the
  existing OCR/cache result.
- **Economic-event matching** compares normalized amount, currency, direction,
  date, party, reference, description, provider/account evidence, and document
  hashes. It creates a durable review case; it does not silently choose an
  accounting record.

A duplicate is the same economic event represented more than once. A related
settlement is a distinct event, such as a bill accrual and its payment, an
invoice and its deposit, a transfer and its clearing entry, or a nearby
cross-currency amount. Related events are never automatically suppressed.

## Deployment

`drizzle/meta/_journal.json` does not include the handwritten `0019` through
`0024` migrations. `bun run db:migrate` therefore does **not** install this
feature. The unattached canonical deployment repository must apply and verify
the exact migration and RLS sequence under its migration-only identity. Do not
invoke these application scripts against production.

The migration command runs `0019_inbox_review_foundation.sql` through
`0024_tenant_lineage_integrity.sql` in order. It records a SHA-256 checksum for each
migration in `app_manual_migrations`, skips already-applied files, rejects
changed applied files, and serializes concurrent runners with an advisory lock.
Run it with the same migration-owner credentials used for other schema changes.
The application runtime must use a non-owner PostgreSQL role covered by the RLS
policies; keep migration-owner credentials out of the web/worker runtime.
`drizzle/rls_hardening.sql` documents the staged role and FORCE-RLS rollout.
Do not enable FORCE until every context-free system route has been moved to an
explicit administrative connection and every tenant route sets organization
context.

`0023` adds payload-bound, exactly-once operation records for journal-producing
bill and invoice payment transitions. `0024` adds organization-consistent
lineage constraints so a source, candidate, document, duplicate case, merge,
and journal link cannot cross tenant boundaries.

Before enforcement or backfill, the canonical runbook must run the read-only
preflight for the reviewed organization and retain its strict/JSON evidence.

It reports duplicate document hashes, repeated active provider identities,
origin sources linked to multiple journals, sources with multiple current
candidates, invalid source pairs, unprocessed or quarantined legacy destructive
matches, and orphaned polymorphic document attachments. Successfully converted
legacy rows no longer keep this preflight section red. `--strict` exits with
status 2 when sampled findings exist.

After the preflight is clean, the canonical runbook must compare strict preflight
and read-only validation status before promoting the `NOT VALID` checks from
`0020`.

Promoting the constraints is a production mutation. The canonical deployment
runbook must execute the write mode under the approved migration identity during
the maintenance window after the strict preflight and read-only status agree.

The validation command covers source record state, direction, economic-event
class, canonical source ordering, match score, match class, disposition, and
resolution action. PostgreSQL already applies these checks to new rows; this
gate verifies all pre-migration rows before marking the constraints validated.
Run validation during a low-traffic deployment window because PostgreSQL must
scan the affected tables.

## Twelve-month backfill

The canonical runbook must produce a non-mutating, organization-scoped dry run
with an explicit as-of date before considering any backfill.

Applying the backfill is a production mutation. The canonical runbook must use
an approved migration identity, explicit organization, reviewed as-of date and
bounded batch size, and must record progress without exposing a reusable write
recipe in this application document.

Apply mode synthesizes a `legacy_journal` source record for each effective
posted journal that lacks an origin source, links existing documents, creates
the origin ledger link, and invokes the duplicate matcher. It never merges,
deletes, or edits journal lines. Historical matches always remain review cases.
Because a journal header stores a functional total but may not store a reliable
original-currency total, legacy matcher inputs use the functional amount and
currency and retain the transaction currency in raw evidence rather than
guessing an FX amount.

## Matcher modes and review

Existing organizations begin in `shadow`; `off`, `shadow`, and `enforce` are
available through the Possible Duplicate rule configuration. Exact replay and
document uniqueness remain active independently of semantic matcher mode.

- Score 70 or higher is blocking in enforce mode.
- Score 50 through 69 is shadow telemetry.
- Amount and date alone are insufficient.
- Identical document bytes create a 100-confidence blocking case even while
  semantic matching is in shadow mode.
- `keep_separate` records negative-match memory until relevant input hashes or
  the matcher version changes.

Approval queries unresolved blocking duplicate cases directly. A generic
finding note cannot clear a Possible Duplicate case.

Identical bytes retain one database document and OCR result. Physical object
keys include a generation ID, so cleanup of an older deleted document cannot
remove a same-hash re-upload that committed in the meantime.

Manual bill and invoice payments require a stable idempotency key. The locked
domain row, payment journal, normalized payment source, ledger-source link, and
operation result commit atomically. A same-key retry returns the recorded
result; a same key with a different payload is rejected.

## Safe posted merge

Posted merges are non-destructive. The duplicate header receives
`duplicate_of_header_id`; both headers and all lines remain intact, and
`journal_duplicate_merges` records the actor, reason, evidence, idempotency key,
and reversal. Accounting consumers use the shared effective-journal predicate
and count only the canonical header. Unmatch clears the active pointer and
records a reversal, restoring the original transaction losslessly.

Do not use the legacy hard-delete match workflow. Legacy `match_history` rows
must be audited and converted only after their snapshotted loser can be fully
restored; incomplete snapshots require manual quarantine.

### Legacy destructive-match conversion

After `0022` is verified, the canonical runbook must inspect active, unprocessed
legacy rows using a bounded, organization-scoped dry run and retain the JSON
evidence.

Conversion is a production mutation. The canonical runbook must preserve the
reviewed organization and batch bounds, execute through the approved migration
identity, and inspect quarantines before any additional batch.

Apply mode is idempotent and revalidates under row/advisory locks. A convertible
row must have a complete current-schema snapshot, including explicit currency,
original-amount, and FX fields; posted/nonzero/balanced journals; exact legacy
survivor linkage; matching amount, currency, direction, and compatible event
class; valid same-organization references; no reused IDs or idempotency keys;
no conflicting bill/invoice ownership; and no active safe-merge membership.
The script restores the deleted header and all lines first inside its
transaction, verifies the restored totals, creates the safe merge, then sets
`duplicate_of_header_id`. It never reconstructs fields that were not captured.

Invalid rows are not inserted into `journal_duplicate_merges`, because that
table intentionally requires two real header foreign keys. Instead, `0022`
provides `legacy_match_conversion_records`: a durable audit/quarantine row with
the validator version, stable snapshot digest, reason codes, details, actor, and
manual-review fields. The legacy history and snapshots remain untouched. This
also means pre-Inbox snapshots that lack currency/FX lineage will be
quarantined rather than silently defaulted to USD. Use `--quarantines` for the
manual work queue.

The legacy workflow could mutate the surviving journal's memo, party, date, and
reference without preserving its pre-merge header. Conversion preserves the
current survivor and records that limitation in merge evidence; it cannot
losslessly reconstruct metadata that the legacy snapshot never stored. The
same applies to reconciliation or source-link rows that the old cascade delete
may already have removed; the converter restores only evidence present in the
snapshot and never fabricates missing lineage.

## Rollout and rollback

1. Apply migrations and RLS, run the preflight, then validate the deferred
   checks.
2. Keep existing organizations in shadow mode.
3. Run the 12-month dry run, then apply organization-by-organization in bounded
   batches.
4. Observe confirmation rate, keep-separate rate, prevented postings, unresolved
   age, matcher latency, and merge/unmerge failures for at least seven days.
5. Enable blocking only after reviewer-confirmed precision is at least 95%.
   Raise the blocking threshold and repeat calibration when it is lower.

Run the read-only operational report for all organizations or one organization:

```bash
bun run dedup:health
bun run dedup:health --org=<organization-id>
bun run dedup:health --json
```

The report covers exact request/provider replay suppression, canonical-document
evidence reuse, cases by disposition and signal combination, structured review
outcomes, the reviewer-confirmed precision proxy, unresolved age, merge state,
and matcher latency. Its output includes the measurement limitations: replay
and latency events begin accumulating only after this instrumentation is
deployed, historical byte-reuse attempts cannot be reconstructed, and failed
transactions do not leave workflow events because their transaction is rolled
back.

To roll back enforcement, set the matcher to `shadow` or `off` and stop new
backfill batches. Do not delete source evidence, cases, decisions, or audit
events. Reverse a posted merge through unmatch; never restore visibility by
deleting the canonical journal.
