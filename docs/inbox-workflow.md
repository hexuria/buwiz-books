# Inbox review workflow

All newly submitted accounting transactions enter **Inbox** before they can
become posted journal entries. This applies to manual entry, CSV imports,
scanned documents, bills, and inbound email.

## Lifecycle

1. The source payload is recorded with a stable external ID and content hash.
2. A balanced transaction candidate is created without changing the ledger.
3. Book rules run immediately and create findings against the Inbox item.
4. A reviewer can correct extracted accounting fields and heuristic event type,
   resolves blocking Book findings, and approves or rejects the item.
5. Approval locks the Inbox item and candidate, revalidates the accounting
   period and balance, then creates the posted journal atomically.

Review rules are not part of this lifecycle. They run on demand across the
posted ledger and attach to journals and account-months rather than to Inbox
items — see [Review rules](#review-rules) below.

Exact duplicate provider records are idempotent. Possible cross-source
duplicates create a blocking finding and must be reviewed. Whether semantic
matches block or are only recorded depends on the `possible_duplicate` agent's
`mode` (`enforce` / `shadow` / `off`), which is per-organization and defaults to
`enforce`; `bun db:review-rules:status` reports the effective value for a given
database. Operational deployment, backfill, matcher thresholds, and safe merge
behavior are described in
[Transaction deduplication operations](./transaction-deduplication.md).

### Vendor bills

Approval writes a bill as well as its journal when the item is a vendor bill:
a Bills-editor submission, or an emailed or uploaded paper whose accounting
source is classified `bill_accrual` and whose entry touches Accounts Payable.
The bill goes through the same core the Bills editor uses
(`src/lib/posting/bill-core.ts`), lands in `awaiting_payment` linked to its
accrual journal, and appears in Bills and A/P aging. The entry must credit the
mapped A/P account on one line, with every other line an expense debit, and
every amount must be whole cents: bills store two decimals, so a sub-cent
amount blocks approval instead of being rounded. A `bill_accrual` paper booked
straight against cash posts as an ordinary journal with no bill. Nothing
extracts a due date yet, so these bills are due on the bill date until their
terms are set on the bill.

A Bills-editor bill can also be approved, scheduled, paid, voided or deleted on
the Bills page while its Inbox item is still pending. Those actions already
post, cancel or remove its accrual, so the Inbox refuses to approve that item;
reject it instead.

## Inbox v2 (per-organization preview)

Admins can turn on the new Inbox under **Settings → General → New Inbox**
(`inboxV2` in the organization's metadata; off by default). Both screens read
the same Inbox items, so switching moves no data and open items carry over.

- The list holds only what needs a person: open items and failed ones, never
  approved, rejected, or dismissed. The sidebar's Inbox badge is its length.
- Each item carries one reason: **Failed** (the item failed, or its source could
  not be processed), **Needs a fix** (an open blocking check, or details still
  missing), **Jev unsure** (a low-confidence category, or — until autonomy lanes
  exist — any item Jev is not cleared to approve on its own), and **Spot check**
  (reserved for autonomy hold-back samples; nothing produces it yet).
- The reading pane is the real editor, prefilled: vendor bills open in the Bills
  editor, everything else in the New transaction editor on its tab. Its Save
  runs the candidate correction and the book checks; Approve first saves any
  unsaved edits the same way, then approves through the shared posting cores.
  Approve stays off while a blocking check is open.
- Keyboard: `j` / `k` move, `a` approves, `r` rejects with a reason, `e` jumps
  into the editor. Shortcuts are ignored while typing.
- A sales invoice from a paper is booked as an entry; approval does not create
  an invoice record yet.
- A correction keeps each line's counterparty: payable and receivable lines
  take the entry's vendor or customer, and other lines keep the party they had
  unless the correction names one.

## Review policy

- **Book rules** detect missing or invalid accounting data. A finding with
  `blocking` impact prevents approval until it is resolved; a `warning` stays
  visible and lets approval through.
- **Review rules** detect anomalies across posted journals. They never gate an
  individual approval. A `blocking` review finding gates **period close**, and
  only for the period it falls in.
- Organizations can require a different submitter and approver. An owner can
  override that policy only when owner overrides are enabled and a reason is
  recorded.

Impact is per-agent and per-organization, and the group only supplies the
default. A rule's group determines _when it runs_, not how hard it bites.

## Review rules

**Settings → Review Rules** configures the rule catalog for the organization —
on or off, **Stop** (stored as `blocking`) or **Warn** (`warning`), thresholds
and lookback — and holds the ledger scan with its findings. It saves through the
same server functions the retired Review Agents page used, and the old
`/review-agents` address now redirects to the Inbox. Each finding in the Inbox
links to its rule there. Two groups, two moments:

| Group                        | Count | Runs                                                                   | Findings attach to            |
| ---------------------------- | ----- | ---------------------------------------------------------------------- | ----------------------------- |
| **Book** (_Inbox checks_)    | 9     | Automatically, on every candidate at ingest and after every correction | The Inbox item                |
| **Review** (_Ledger checks_) | 5     | Only when someone presses **Scan books**                               | A journal or an account-month |
| **System** (_System checks_) | 3     | Raised by inbound processing. Not configurable, not runnable           | The Inbox item                |

Group is not a perfect proxy for cadence, and the UI states the cadence per
agent rather than deriving it: `transaction_in_parent_category` is a Review rule
that _also_ runs at ingest, and `low_confidence_category` is a Book rule the
on-demand run can never evaluate, because it reads a classifier confidence score
that does not survive posting.

### Resolving findings

A Book finding clears in one of two ways: **correct the entry**, which re-runs
the rules and auto-resolves anything no longer true, or **document an
exception** with a note of at least three characters. Possible duplicates accept
neither — they require a structured decision in the duplicate comparison view.

A Review finding has no Inbox item, so it is resolved in place from **Ledger
findings** under Settings → Review Rules, with the same note requirement. Resolving is
permanent: a later run that observes the same condition advances `lastSeenAt`
but does not reopen the finding, because re-observing a fact a reviewer already
documented an exception for is not new information.

### The on-demand run

**Scan books** evaluates only the five Review rules, as of a date you
choose — set it to a period end to reproduce a close. Book rules are excluded
deliberately: they already ran at ingest, against the candidate, at the only
point where their findings could still be acted on. Running them across posted
journals produced blocking findings on entries that can no longer be un-posted.

### The catalog

`review_rule_definitions` is a **global** table — no `organization_id`, and
excluded from every RLS policy — so one empty table means every organization
sees zero agents. It is seeded from `src/lib/inbox/review-rule-catalog.ts` on
every path that builds a database. If Settings → Review Rules reports that no
agents are set up, inspect the database before anything else:

```bash
bun db:review-rules:status
```

See [Database Operations](../internal-docs/infrastructure/database.md) for the
production procedure.

## Inbound email

Each organization can configure its exact inbound recipient in **Inbox
settings**. Point a Resend inbound-email webhook at:

```text
POST /api/inbound-email/resend
```

Configure `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`. Queued email and
attachment jobs are drained by a worker endpoint:

```text
POST /api/internal/worker
Authorization: Bearer <INBOX_WORKER_SECRET>
```

In production a Cloud Scheduler job calls it every minute; in development an
in-process drain runs instead (`JOB_DRAIN_MODE=inline`). If neither is active,
inbound email is accepted and then never processed — the jobs stay `queued`
indefinitely. Deployment, the exact schedule, and the "jobs are stuck" triage
flow are in the [job worker runbook](../internal-docs/infrastructure/job-worker.md).

The worker downloads the email and attachments, stores evidence in the document
vault, and leaves the candidate in `needs_information` for accounting review.
The endpoint is safe to poll: it claims one queued job at a time and retries
failed jobs with backoff. A crashed final lease atomically marks the job,
ingestion event, source, Inbox item, finding, and audit event as failed. An
exact webhook replay can requeue that work only while the original failure and
candidate are still open; it cannot reopen an approved or rejected lifecycle.

### Categories and counterparties (stage 2)

When extraction produces complete facts, the candidate gets two unselected
placeholder lines and a `classify_inbox_candidate` job. That job:

- picks the **category line's** account (the debit of a purchase, bill, or
  payroll; the credit of a sale or invoice) from the organization's own active
  leaf accounts, sent to the model as a closed list of account-number codes.
  A code outside the list is refused. No fit, a pick below the organization's
  low-confidence threshold, or any model failure puts the line on the mapped
  Uncategorized Expense account instead (or leaves it unselected where no
  uncategorized account is mapped), so the blocking `uncategorized` finding
  stays open. A missing category is only ever a suggestion in the line's
  prediction evidence; accounts are never created;
- matches the **counterparty**: tax id, then sender or printed email, then
  vendor alias, then exact name; failing those, the model chooses among the five
  most similar parties (`pg_trgm`) or answers "new", which drafts a
  `create_party` proposal for a human;
- raises the blocking `party_payment_details_changed` finding when the document
  asks for payment to bank details that differ from the matched payee's stored
  ones. Editing the entry never clears it; resolve it with a note after
  confirming the change through a contact you already trust.

The payment side (bank, card, cash, AP, or AR) is always left for the reviewer.
With Jev opted in, Jev answers both picks first and Gemini is the fallback.

Event classes inferred from email text, OCR, or document extraction are
reviewer-editable and every change is audited. Provider-owned payment, payroll,
transfer, bill, and invoice identities remain protected from silent rewriting.
Rejecting a reviewable failure retires its unposted candidate and unshared
origin evidence so it cannot reopen duplicate cases later.

### Multi-recipient delivery and sender authentication

An email addressed to the inbound addresses of **several organizations** is
delivered to every matched organization (audit checkpoint C9) — each gets its
own ingestion event, source record, Inbox item, and processing job, and the
webhook response lists every delivery. Before this, only one arbitrary match
received the document.

Attachment downloads are bounded: the worker refuses attachments over 20 MB
(the same ceiling as interactive uploads) and abandons downloads after 60
seconds, recording the attachment as failed instead of pinning the worker.

**Sender authentication (recorded decision):** authenticity of the webhook is
established by the Resend/Svix signature; SPF/DKIM/DMARC evaluation of the
original sender happens at Resend before the event ever reaches us. The app
does NOT additionally verify the `from` address against a per-organization
sender allowlist — every accepted email lands as an unposted candidate that a
human must review, so a spoofed sender can at worst add review noise, never
post to the ledger. Per-org sender allowlists are tracked in
[docs/audit-backlog.md](audit-backlog.md), not implemented here.

## Routines

A routine is how papers get into the Inbox: a trigger plus its configuration
(`routines` table). Every ingestion event and processing job a routine produces
carries its `routine_id`. Routines are managed through the server functions in
`src/routes/api/-routines.ts` (list, create, update, enable, disable, rotate
secret; writes need `integration:authorize`).

- **Chart gate.** Enabling a routine — at creation or later — requires an applied
  chart of accounts: every bank, bill, and invoice mapping key must resolve
  through `src/lib/coa/resolve-mapped-account.ts`. Otherwise the request fails
  with "Set up your chart of accounts first." Disabling never needs a chart.
- **Inbound email** is each organization's first webhook routine. It is
  provisioned (enabled) by the Resend webhook the first time an email arrives
  for the organization, so existing intake keeps working unchanged. While it is
  disabled, an email is still **recorded** — the ingestion event keeps the full
  provider payload with status `skipped` — but nothing is processed, provider
  replays are not requeued, and a `routine_disabled_skipped` workflow event says
  so.
- **Generic webhooks.** `POST /api/routines/<routineId>/webhook` with a JSON
  object body of at most 1 MB and three headers:

  ```text
  X-Buwiz-Timestamp: <unix seconds, within 300 s of our clock>
  X-Buwiz-Signature: <hex HMAC-SHA256 of "<timestamp>.<raw body>">
  X-Buwiz-Event-Id:  <the sender's unique id for this event>
  ```

  The HMAC key is the whole secret string returned by the rotate-secret server
  function — the only time it is ever shown; it is stored encrypted in
  `routine_secrets` and referenced from the routine by `secret_ref`. Rotating
  retires the previous secret immediately. Every rejection (401 signature or
  timestamp, 413 size, 404 routine) happens before any row is written. An
  accepted payload becomes an ingestion event and a `routine_webhook` job whose
  handler creates a source record and an Inbox item in `needs_information`.
  Event ids are deduplicated per routine; a suppressed duplicate returns
  `duplicate: true` and writes an `exact_replay_suppressed` workflow event
  (flagging a replayed id whose body changed) instead of vanishing.

- **Schedules** use presets, not cron: `{ preset: "hourly" | "daily" | "weekly",
at?: "HH:MM", weekday?: 0-6, timezone, source }` (`at` defaults to `00:00`;
  hourly uses its minutes; `weekday` is required for, and only allowed on,
  weekly). Times are wall-clock in the IANA `timezone`: a slot inside a
  spring-forward gap runs shifted forward by the gap, a slot inside a fall-back
  overlap runs once (the earlier instant), and hourly fires every real hour.
  Creating, rescheduling, or enabling a schedule computes `next_run_at`;
  disabling clears it. Every worker drain pass that may run
  `routine_schedule_run` jobs first claims due routines (`FOR UPDATE SKIP
LOCKED`, one org-context transaction each), enqueues one job per slot
  (`dedupe_key routine:<id>:<slot>`), and advances `next_run_at` to the next
  future slot — a late pass fires a missed slot once, never a backlog. The job
  runs the `source` named in the config (`src/lib/routines/schedule-sources.ts`;
  only `noop` exists so far) and records a `routine_schedule_run` workflow
  event. `max_concurrent_runs` is stored but not yet enforced.

## Rule snapshots

A rule snapshot (`rule_snapshots`) freezes an organization's effective rule
configuration: one `{ruleKey, enabled, impact, config, formulaVersion}` entry
per configurable rule, with the accounting-settings thresholds baked into the
book rules so a snapshot never moves when settings change later. Snapshots are
immutable — no update path exists and the database rejects every `UPDATE` —
and are managed through `src/routes/api/-rule-snapshots.ts` (create from live
configs, list, get, pin, unpin; writes need `agentRule:configure`, reads
`agentRule:view`).

- **Pinning.** A routine's `rule_snapshot_id` names the rules its papers are
  evaluated against; null means the organization's live `review_rule_configs`.
  A paper is traced to its routine through its primary source record's
  ingestion event. Every evaluation of a routine paper uses the pin: stage 2's
  re-evaluation after classifying an emailed draft (whose pick threshold is the
  pinned low-confidence threshold too) and a reviewer's correction. Manual
  entry, imports, and bills are not routine papers and always use live configs.
  A pinned snapshot that cannot be read fails the evaluation rather than
  silently falling back to live.
- **Traceability.** Every book finding carries `evidence.ruleSet =
{ source: "live" | "snapshot", snapshotId, routineId }`, and the
  `submitted` / `candidate_classified` / `candidate_corrected` workflow events
  record the same value, so a paper evaluated with no findings is traceable too.
- **Shadow.** `shadow_rule_snapshot_id` names a second snapshot that is
  evaluated alongside and logged as a `rule_shadow_evaluated` workflow event
  (its findings, the enforced findings, and the difference). Shadow output is
  never a review finding, so it can never block approval or period close.
- **Promote and roll back.** Pinning the routine's shadow snapshot promotes it
  and clears the shadow; the previous snapshot stays for rollback. A pinned or
  shadowed snapshot cannot be deleted (`ON DELETE RESTRICT`).
- **Not yet covered.** Duplicate detection (`possible_duplicate`) runs on
  source records across routines and still reads the live config; review
  agents run on demand against the posted ledger. Both are captured in a
  snapshot and replayed by the scorecard. System rules
  (`party_payment_details_changed`, the source-processing rules) read no
  config, so no snapshot includes or switches them off.

## Rule scorecard

`bun eval:scorecard` replays a pile of papers under a rule set and prints the
metrics: `cases`, `real_problems_caught` (of `real_problems_total`),
`false_alarms`, `approved_zero_edits`, `locked_cases_passing` of
`locked_cases_total`, and `memory_hit_rate` / `cost_per_100` (null until
memory lands, and always null in recorded mode).

```text
bun eval:scorecard --pile golden --json                     # no network, no database
bun eval:scorecard --pile golden --rules <snapshot-id> --org <orgId>
bun eval:scorecard --pile org:<orgId> --rules live --limit 500
```

- `--pile` is a JSONL file, `golden` (`tests/evals/scorecard/golden.jsonl`),
  or `org:<orgId>` — the organization's most recently approved or rejected
  Inbox items, read-only inside its org context. `--rules` is `default`
  (catalog defaults), `live`, a snapshot id, or a JSON rules file. Only the
  `recorded` chain runs: `default` and `jev` would call live models, which is
  the nightly harness's job, not this command's.
- A pile line is one case: `id`, `category`, `locked`, `candidate`
  (`transactionDate`, `transactionType`, `originalCurrency`,
  `functionalCurrency`, `exchangeRate`), `lines` (amounts in the original
  currency, optional `categoryConfidence`), `accounts` keyed by the ids the
  lines use, `party`, `documents`, optional `duplicate` (`source` and
  `priorRecords` as duplicate-matcher inputs) and `ledgerHistory` (recent
  posted rows, for `material_expense`), `paymentDetails` (the payee's stored
  and printed bank details, for `party_payment_details_changed`), `expected`
  (`problems` — the rule keys of the paper's real problems — and optional
  `blocked`), and `outcome` (`decision`, `edits`).
- Organization piles take labels from `ai_eval_cases` rows with task
  `inbox_rules`, `input_ref.candidateId`, and `expected = { problems, blocked?,
locked? }`; unlabeled cases count toward `cases` and `approved_zero_edits`
  only. They replay book rules; duplicate, ledger, and payee bank-detail
  context is not rebuilt.
- **CI gate.** `tests/evals/scorecard.eval.ts` runs the golden pile under
  `tests/evals/scorecard/golden-rules.json` in `bun run test:evals`, which CI's
  hermetic job runs, and fails unless every locked case reproduces exactly.
  Unlocked golden cases hold the known misses and false alarms the scorecard
  tracks.

## Current integration boundary

This release includes the normalized source, connection, ingestion, evidence,
candidate, review, and ledger-linking foundation. Manual entry, both CSV
importers, bills, scans/documents, and inbound email use that foundation.
Provider OAuth and sync adapters for bank/card, Ramp, Gusto, Stripe, and other
external systems remain separate connector work; their records should enter
through the same source-record and candidate pipeline.
