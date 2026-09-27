# Inbox workflow

Every accounting transaction enters the **Inbox** before it becomes a posted journal entry: manual
entry, CSV imports, scanned and uploaded documents, bills, inbound email, and signed webhooks. The
Inbox only automates typing. What an approval saves is exactly what a person would save in the
matching editor, through the same domain code, and every failure degrades to "needs a person",
never to wrong books.

```text
routine fires (inbound email | signed webhook | schedule)
  -> raw paper saved (ingestion event, source record, documents)
  -> extraction (OCR is Gemini-only; text sent anywhere else is redacted first)
  -> classification: a remembered answer, if one matches — else Jev (opted in) or Gemini,
     choosing only from closed lists (this organization's accounts and parties)
  -> book rules: the routine's pinned rule snapshot, or the live rule configuration
  -> Jev approves (its lane earned auto, every check passes, not a spot check)
     OR the Inbox: the item waits for a person
  -> Approve = the shared posting core -> journal (+ bill) -> books
```

**Who approves.** A person, or — only on a lane that has earned it — Jev. Jev approval is off
until an admin turns it on, is earned one vendor and one kind of paper at a time, and never
touches the papers that always need a person: new vendors or customers, changed bank details, an
email whose sender cannot be verified, possible duplicates, closed periods, and anything a check
flags (see [Jev approval](#jev-approval)). Either way the posting is identical: letting Jev approve
changes who presses the button, never a ledger rule.

## Lifecycle

1. The source payload is recorded with a stable external id and content hash; a replay of the
   same provider event is recognized, not re-ingested.
2. A balanced transaction candidate is created without changing the ledger.
3. Book rules run immediately and create findings against the Inbox item.
4. A reviewer corrects the entry if needed, resolves blocking findings, and approves or rejects —
   or, on a lane at auto, Jev approves a paper that passes every check.
5. Approval locks the item and candidate, re-checks the accounting period and the balance, and
   posts through the same core the editors use (`src/lib/posting/`), atomically.

Exact duplicate provider records are idempotent. Possible cross-source duplicates create a
blocking finding and must be decided in the duplicate comparison. Whether semantic matches block
or are only recorded depends on the `possible_duplicate` rule's `mode` (`enforce` / `shadow` /
`off`), per organization, defaulting to `enforce`; `bun db:review-rules:status` reports the
effective value for a database. Operational detail is in
[Transaction deduplication operations](./transaction-deduplication.md).

## The Inbox screen

`/inbox` is one list of everything that needs a person and a reading pane beside it (a
full-height drawer below `lg`). It is the only Inbox: the classic three-pane page, its six state
filters and search, and the per-organization `inbox_v2` switch that chose between the two screens
are retired. An `inboxV2` key still stored in an organization's metadata is ignored, and an old
link with a `?state=` filter lands on the same screen.

- **What is listed.** Items with details to fill in or ready for review, and failed ones — never
  approved, rejected, or dismissed items (there is no Done folder). Papers still being read
  (received or processing) need nobody yet: a quiet "N papers being read" line counts them. The
  list holds at most 250 items; the sidebar's Inbox badge is its length ("250+" past that).
- **One reason per item**, first match wins, with a filter chip for each:
  - **Failed** — the item failed, or its source could not be processed.
  - **Needs a fix** — an open blocking check, or an entry still missing lines or accounts.
  - **Jev unsure** — a real model-unsure signal: a low-confidence category, or an answer
    classification could not use (a category or counterparty below the threshold, or none at
    all). Classification parks an unsure category on Uncategorized and leaves an unsure
    counterparty empty, so that doubt surfaces as an `uncategorized` or missing vendor/customer
    check; that check alone makes the item Jev unsure, not Needs a fix. Anything the doubt does
    not explain still needs a fix — including the payment side, which classification never
    picks — and the strip names the doubt after it ("… Jev isn't sure about the category (41%
    sure).").
  - **Spot check** — a paper Jev would have approved on a lane at auto, held back for a person
    ("Jev would approve this — spot check."). The person's decision is an unbiased label for the
    lane.
  - **Ready to approve** — nothing above: a clean entry, typed by hand, read confidently, or
    answered by a memory. On a lane at suggest (or auto), a paper Jev would approve says so: "Jev
    would approve this. Review the entry and approve it." An emailed paper Jev held because its
    sender could not be verified says that instead: "Sender could not be verified — Jev won't
    approve this on its own. Check who sent it before you approve it."
- **Rows** show who, kind of paper, relative date, amount, and the one reason chip.
- **The reading pane is the real editor, prefilled**: vendor bills open in the Bills editor (with
  the paper beside it), everything else in the New transaction editor on its tab. Save runs the
  candidate correction and the book checks; Approve first saves any unsaved edits the same way,
  then approves through the posting cores. Approve stays off while a blocking check is open.
  Bill lines have Department and Location pickers, as the New transaction editor's lines do, so
  the Missing Department and Missing Location checks clear when a reviewer picks them and saves
  (they post on the accrual's expense lines and on the bill's own lines).
- **The strip** above the editor says the reason, shows **Remembered** or Jev's confidence
  ("Jev 62%") when classification wrote the lines, warns of a possible duplicate (with the
  duplicate comparison below), and holds Approve and Reject. Open checks are listed with their
  resolve-with-a-note and retry actions.
- **Keyboard:** `j` / `k` move, `a` approves, `r` rejects with a reason, `e` jumps into the
  editor. Shortcuts are ignored while typing, with a modifier, or inside another dialog.
- A decision removes the row at once and moves to the next item; a failure puts the row back and
  says why. Once decisions settle, the Inbox, Bills, Transactions and Invoices caches refresh,
  since an approval can create any of them. A rejected paper stays in Documents.
- A correction keeps each line's counterparty: payable and receivable lines take the entry's
  vendor or customer, and other lines keep the party they had unless the correction names one.
- A sales invoice read from a paper is booked as an entry; approval does not create an invoice
  record yet.

### Vendor bills

Approval writes a bill as well as its journal when the item is a vendor bill: a Bills-editor
submission, or an emailed or uploaded paper whose accounting source is classified `bill_accrual`
and whose entry touches Accounts Payable. The bill goes through the same core the Bills editor
uses (`src/lib/posting/bill-core.ts`), lands in `awaiting_payment` linked to its accrual journal,
and appears in Bills and A/P aging. The entry must credit the mapped A/P account on one line, with
every other line an expense debit, and every amount must be whole cents: bills store two decimals,
so a sub-cent amount blocks approval instead of being rounded. A `bill_accrual` paper booked
straight against cash posts as an ordinary journal with no bill. Nothing extracts a due date yet,
so these bills are due on the bill date until their terms are set on the bill.

A Bills-editor bill already exists when its item is approved, and a reviewer may have corrected
the entry in the Inbox first. Approval accrues it through the same core, which brings the bill in
line with what posts — amount, balance due, line items, vendor, bill date and number (its terms
stay as set) — in the approval's transaction, under the same A/P-shape and whole-cent rules. The
bill can also be approved, scheduled, paid, voided or deleted on the Bills page while its Inbox
item is still pending. Those actions already post, cancel or remove its accrual, so approval
refuses, with nothing written, a bill that was deleted, voided, already accrued from Bills
(approving would post it twice), or has payments recorded; reject such an item instead.

### Approval policy

- A blocking book finding prevents approval until it is resolved; a warning stays visible and
  lets a person approve (Jev never approves past an open warning — it is addressed to a person).
- Organizations can require a different submitter and approver (maker-checker, on by default).
  An owner can override that for their own submission only when owner overrides are enabled, and
  the pane then asks for a recorded reason. While maker-checker is on, Jev approves nothing unless
  an admin explicitly opts Jev in.

## Routines (how papers get in)

A routine is a trigger plus its configuration (`routines`). Every ingestion event and processing
job a routine produces carries its `routine_id`, so a paper can always be traced to the routine
that brought it in. Routines are managed through `src/routes/api/-routines.ts` (list, create,
update, enable, disable, rotate secret; writes need `integration:authorize`).

- **Chart gate.** Enabling a routine — at creation or later — requires an applied chart of
  accounts: every bank, bill, and invoice mapping key must resolve through
  `src/lib/coa/resolve-mapped-account.ts`. Otherwise the request fails with "Set up your chart of
  accounts first." Disabling never needs a chart.
- **Inbound email** is each organization's first webhook routine, authenticated upstream by
  Resend's Svix signature. It is provisioned (enabled) the first time an email arrives for the
  organization, so intake needs no setup beyond the address. The address itself is set in
  **Settings → Email → Inbound email** (Save, Generate, Copy; changing it needs
  `integration:authorize`). While the routine is disabled an email is still **recorded** — the
  ingestion event keeps the full payload with status `skipped` — but nothing is processed,
  provider replays are not requeued, and a `routine_disabled_skipped` workflow event says so.
- **Signed webhooks.** `POST /api/routines/<routineId>/webhook` with a JSON object body of at most
  1 MB and three headers:

  ```text
  X-Buwiz-Timestamp: <unix seconds, within 300 s of our clock>
  X-Buwiz-Signature: <hex HMAC-SHA256 of "<timestamp>.<raw body>">
  X-Buwiz-Event-Id:  <the sender's unique id for this event>
  ```

  The HMAC key is the whole secret string returned by the rotate-secret server function — the only
  time it is ever shown. It is stored encrypted in `routine_secrets` and referenced from the
  routine by `secret_ref`; rotating retires the previous secret immediately. Every rejection (401
  signature or timestamp, 413 size, 404 routine) happens before any row is written. An accepted
  payload becomes an ingestion event and a `routine_webhook` job whose handler creates a source
  record and an Inbox item. Event ids are deduplicated per routine; a suppressed duplicate returns
  `duplicate: true` and writes an `exact_replay_suppressed` workflow event (flagging a replayed id
  whose body changed) instead of vanishing.

- **Schedules** use presets, not cron: `{ preset: "hourly" | "daily" | "weekly", at?: "HH:MM",
weekday?: 0-6, timezone, source }` (`at` defaults to `00:00`; hourly uses its minutes; `weekday`
  is required for, and only allowed on, weekly). Times are wall-clock in the IANA `timezone`: a
  slot inside a spring-forward gap runs shifted forward by the gap, a slot inside a fall-back
  overlap runs once (the earlier instant), and hourly fires every real hour. Creating,
  rescheduling, or enabling a schedule computes `next_run_at`; disabling clears it. Every worker
  drain pass that may run `routine_schedule_run` jobs first claims due routines (`FOR UPDATE SKIP
LOCKED`, one org-context transaction each), enqueues one job per slot (`dedupe_key
routine:<id>:<slot>`), and advances `next_run_at` to the next future slot — a late pass fires a
  missed slot once, never a backlog. The job runs the `source` named in the config
  (`src/lib/routines/schedule-sources.ts`; only `noop` exists so far) and records a
  `routine_schedule_run` workflow event. `max_concurrent_runs` is stored but not yet enforced.

## Classification (Jev and Gemini)

When extraction produces complete facts, the candidate gets two unselected placeholder lines and a
`classify_inbox_candidate` job. Classification runs in two stages:

1. **What kind of paper** (`ingest_triage`, `classify_document`).
2. **Which accounts and which counterparty** (`categorize_lines`, `match_party`), from closed lists
   only:
   - the **category line's** account (the debit of a purchase, bill, or payroll; the credit of a
     sale or invoice) is picked from the organization's own active leaf accounts, sent to the
     model as a closed list of account-number codes. A code outside the list is refused. No fit, a
     pick below the organization's low-confidence threshold, or any model failure puts the line on
     the mapped Uncategorized account instead (or leaves it unselected where none is mapped), so
     the blocking `uncategorized` finding stays open. Accounts are never created;
   - the **counterparty** is matched by tax id, then sender or printed email, then vendor alias,
     then exact name; failing those, the model chooses among the five most similar parties
     (`pg_trgm`) or answers "new", which drafts a `create_party` proposal for a person;
   - a document that asks for payment to bank details that differ from the matched payee's stored
     ones raises the blocking `party_payment_details_changed` finding. Editing the entry never
     clears it; resolve it with a note after confirming the change through a contact you already
     trust. Such a paper always needs a person, even after the finding is resolved.

The payment side (bank, card, cash, AP, or AR) is left for the reviewer unless a memory answers
it. **Jev** (TypeSafe AI) is an opt-in data processor: an organization turns it on under
**Settings → AI Credentials** (it is added to the provider allowlist, after a confirmation). Opted
in, Jev runs first for these four tasks with Gemini as the fallback; Jev receives redacted text
only, never document images, and is never used for any other task. Without the opt-in, Gemini
answers alone. Model answers pin confidence to 0..1.

## Memories ("Remember this?")

After correcting a draft, a reviewer who can approve Inbox items may choose **Remember this?** and
a scope: this file (the document's sha256), this sender (sender email plus printed tax id), this
party, or these words (the description's alias-normalized tokens). The prompt first shows how many
papers from the last 12 months the scope would have matched, and on how many it would have
changed the answer. Scopes that can answer more than one party's papers — these words, or a sender
without a party — need `agentRule:configure` (owners and admins). A memory stores the kind of
paper, the party, and each line's account; never bank or payment details, and nothing is written
to the party.

Classification consults memories **before any model**, most specific first (file, sender, party,
words). A hit writes the remembered answer with no model call; the book rules and the
payment-details check still run on it, so blocking findings still block. A memory's accounts and
party must pass the same checks as a model's pick (active leaf accounts of this organization,
still of the type they had, a party of the right kind); one that fails is skipped and the reason
shown on the memory. Two memories of the same specificity that disagree apply nothing and raise
the blocking `memory_conflict` finding. An entry a memory answered carries the **Remembered**
badge; when the remembered answer settles the whole entry and nothing blocks it, it reads Ready
to approve.

After a save that changed the answer (accounts, counterparty, or kind of paper), the pane offers
**Remember this?** above the editor; approving with such a change offers it in a corner card once
the approval lands. Both are optional and block nothing. A hand-entered entry has no kind of paper
of its own, so the prompt first asks **What kind of paper is this?**, offering only the kinds the
entry's accounts allow (an expense paid out cannot be remembered as a sale); when none fits, the
prompt does not appear.

A correction away from a memory's answer before approval — or a reversal or void of the posted
entry, including an undo of Jev's approval — counts as an undo; an answer approved as-is (by a
person or by Jev) resets the count. Two undos in a row turn the memory off. **Settings → Review
Rules → Memories** lists them (uses, undos, whether one turned itself off, and why it would be
skipped today); owners and admins can turn them on or off or delete them. Every save also writes
an `ai_eval_cases` row (`authored`, task `inbox_memory`); replaying it must reproduce the answer
exactly, and CI's recorded evals replay every authored case in
`tests/evals/fixtures/inbox-memory-locks.json` (`tests/evals/memory-lock.eval.ts`).

Event classes inferred from email text, OCR, or document extraction are reviewer-editable and
every change is audited. Provider-owned payment, payroll, transfer, bill, and invoice identities
remain protected from silent rewriting. Rejecting a reviewable failure retires its unposted
candidate and unshared origin evidence so it cannot reopen duplicate cases later.

## Jev approval

Jev may approve Inbox papers itself once it has earned it, one **lane** at a time: one vendor or
customer and one kind of paper (`ai_autonomy_lanes`, migration 0060). **Settings → Jev approval**
lists the lanes with their agreement and calibration; admins change them.

- **Levels.** A lane is created at **watch** the first time Jev proposes a paper for it: Jev's
  answers are labeled and whether it _would_ approve is logged, nothing else changes. Admins
  promote it to **suggest** — the Inbox says when Jev would approve — and then to **auto** — Jev
  approves — one step at a time. Each promotion re-checks, at that moment, that 200 of Jev's own
  answers on the lane were reviewed with at least 98% accepted unchanged (`AUTONOMY_CRITERIA`,
  counted over the lane's own labels). Auto also needs the lane's vendor or customer (the lane
  for papers with no known party can never approve), an amount cap, and a confidence threshold
  the lane's calibration supports. Admins can demote a lane at any time.
- **Automatic demotion.** After every new label, an auto lane whose last 50 labels fall below 95%
  accepted drops back to suggest by itself, and a lane in that state is not promoted.
- **Labels.** A proposal is a draft classification answered (a category it picked at or above the
  threshold) or a remembered answer. It is recorded with its lane after classification
  (`jev_proposal_recorded`), and the first person's decision on it becomes the lane's label
  (`ai_run_feedback.lane_id`): approved unchanged — date, currency, counterparty, and every line's
  account, side and amount that Jev answered — is **accepted**; any change is **corrected**; a
  rejection, or an undo of Jev's own approval, is **rejected**. Filling what Jev left blank (the
  payment side) is not a correction. Each label records whether Jev _would_ have approved the
  paper, so Settings and the scorecard show agreement per lane.
- **Remembered answers.** A paper a classification memory answered is a proposal too, recorded as
  the memory's, with a confidence of 1. Its label counts toward the lane's agreement and its
  demotion — a lane at auto approves remembered answers as well — but not toward promotion or
  calibration, which are about Jev: a remembered answer replays a person's fix and has no model
  confidence. So a vendor whose every paper is remembered never earns a lane; its papers wait, one
  click from approval, for a person.
- **Calibration.** Labels are bucketed by Jev's confidence. A lane's threshold may not sit below
  the lowest bucket from which every observed bucket up was accepted at least 98% of the time on at
  least 30 labels.
- **The switches.** **Let Jev approve Inbox papers** is the organization's switch, off by default:
  off, no lane approves anything and lanes keep learning. The **AI kill switch** (Settings → AI
  Credentials) stops every AI feature, Jev approval included. While the organization requires a
  different approver (maker-checker), Jev approves nothing unless an admin ticks the opt-in under
  Jev approval.
- **When Jev approves.** Only when every condition holds: the lane at auto with its party, cap and
  threshold; the organization's switch on; the AI kill switch off; maker-checker off or Jev opted
  in; confidence at or above the lane's threshold; for a paper that came in by email, a verified
  sender (below); the total at or under the lane's cap, compared exactly; every line on an account
  and balanced to the cent; and the paper not sampled as a spot check. A paper is decided when it
  is proposed: promoting a lane or turning the switch on does not approve papers already waiting in
  the Inbox.
- **Always a person.** Whatever a lane's level, these stay in the Inbox: a new vendor or customer
  (or no known one); a paper that asks for payment to different bank details — ever, even after
  that finding was resolved; an emailed paper whose sender could not be verified; a possible
  duplicate; a closed period; any open blocking check or warning; and anything the approval itself
  refuses. A `jev_auto_approval_held` workflow event says why a paper was held.
- **Emailed papers: a verified sender, always.** A paper with inbound email anywhere in its
  lineage — an emailed candidate, or a source that is an inbound message, an attachment or body of
  one, or came in on an email channel — is approved by Jev only if **every** message behind it
  passed sender authentication (see [Sender authentication](#sender-authentication)) and came from
  a sender the paper's party already uses: the From domain is the domain of the party's stored
  email, or of the From of one of that party's papers a **person** approved, or a subdomain of one
  of those (never a parent) — Jev's own approvals vouch for nothing. At a shared mailbox provider
  (gmail.com, outlook.com, yahoo.com and the like, in any country) only the exact address counts,
  since anyone can sign up there. A paper with no message or no verdict on record is not verified.
  Held papers read **Sender could not be verified — Jev won't approve this on its own**, with the
  reason in their `sender_unverified` hold. Webhook-routine papers are not email (every request is
  HMAC-signed) and are unaffected.
- **Spot checks.** A share of what Jev would approve (10% by default, set under Jev approval) is
  chosen before posting — a hash of the candidate id and the organization's own salt — and left in
  the Inbox as **Spot check**. Nothing is posted and reversed; the person's decision is the lane's
  unbiased label.
- **How it posts.** The `jev_auto_approve` job decides again under the paper's lifecycle lock and
  approves through the same approval and posting cores as a person. Jev is recorded as the system
  actor: `review_decisions.actor_type` is `system` with `actor_key` `jev` and no `actor_id`;
  `inbox_items.resolved_by` stays empty (a user column never borrows a person); the journal's
  `created_by`, the bill's `approver_id` and the activity rows say `system:jev`, and the activity
  log names the lane, the confidence and the rule snapshot. Entries Jev approved show a **by Jev**
  tag in Bills and Transactions.
- **Undo.** On the entry's screen, **Undo Jev approval** (needs Inbox approve, and a reason) posts
  a reversal — never a delete — dated like the original, or today (the first open day) when that
  period is closed; voids the bill it created, refused once anything was paid; returns the paper to
  the Inbox on a new revision; counts as a rejected label for the lane; and, when a memory answered
  the paper, counts an undo against that memory. An entry already reversed, matched to a bank
  statement, or in a finalized reconciliation cannot be undone this way.
- **Categories.** `categorize` stays structurally manual (`STRUCTURAL_MANUAL_KINDS`) for per-kind
  autonomy and every other path; only the inbox_approve lane may apply the category of a paper it
  approves (`INBOX_APPROVE_LANE_EXCEPTIONS` in `src/lib/ai/autonomy.ts`, with the reasons and
  guards). Classification never picks the payment side, so a paper Jev alone read is never
  complete enough to approve; a remembered answer can make it so.

## Rules

**Settings → Review Rules** configures the rule catalog for the organization — on or off,
**Stop** (stored as `blocking`) or **Warn** (`warning`), thresholds and lookback — and holds the
ledger scan, the rule snapshots, and the memories. The retired Review Agents page's address,
`/review-agents`, redirects there (an old `?agent=` link opens that rule) or to the Inbox. Three
groups:

| Group                        | Runs                                                                   | Findings attach to            |
| ---------------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| **Book** (_Inbox checks_)    | Automatically, on every candidate at ingest and after every correction | The Inbox item                |
| **Review** (_Ledger checks_) | Only when someone presses **Scan books**                               | A journal or an account-month |
| **System** (_System checks_) | Raised by inbound processing and classification; not configurable      | The Inbox item                |

Impact is per rule and per organization; the group only supplies the default. Group is not a
perfect proxy for cadence, and the UI states the cadence per rule: `transaction_in_parent_category`
is a Review rule that _also_ runs at ingest, and `low_confidence_category` is a Book rule the
ledger scan can never evaluate, because it reads a classifier confidence that does not survive
posting.

- **Resolving.** A Book finding clears by **correcting the entry** (the rules re-run and resolve
  anything no longer true) or by **documenting an exception** with a note of at least three
  characters. Possible duplicates accept neither — they need a structured decision in the
  duplicate comparison. A Review finding has no Inbox item and is resolved in place under
  **Ledger findings**; resolving is permanent, and a later scan that sees the same condition only
  advances `lastSeenAt`.
- **Scan books** evaluates only the Review rules, as of a date you choose — set it to a period
  end to reproduce a close. A blocking Review finding gates **period close** for its period; it
  never gates an individual approval.
- **The catalog.** `review_rule_definitions` is a **global** table — no `organization_id`, and
  excluded from every RLS policy — so one empty table means every organization sees no rules. It
  is seeded from `src/lib/inbox/review-rule-catalog.ts` on every path that builds a database. If
  Settings → Review Rules reports that none are set up, inspect the database first with
  `bun db:review-rules:status`; the production procedure is in
  [Database Operations](../internal-docs/infrastructure/database.md).

### Rule snapshots

A rule snapshot (`rule_snapshots`) freezes an organization's effective rule configuration: one
`{ruleKey, enabled, impact, config, formulaVersion}` entry per configurable rule, with the
accounting-settings thresholds baked into the book rules so a snapshot never moves when settings
change later. Snapshots are immutable — no update path exists and the database rejects every
`UPDATE` — and are managed from the Rule snapshots card and `src/routes/api/-rule-snapshots.ts`
(create from live configs, list, get, pin, unpin; writes need `agentRule:configure`, reads
`agentRule:view`).

- **Pinning.** A routine's `rule_snapshot_id` names the rules its papers are evaluated against;
  null means the organization's live `review_rule_configs`. A paper is traced to its routine
  through its primary source record's ingestion event, and every evaluation of a routine paper
  uses the pin (classification's re-evaluation, whose pick threshold is the pinned low-confidence
  threshold too, and a reviewer's correction). Manual entry, imports, and bills are not routine
  papers and always use live configs. A pinned snapshot that cannot be read fails the evaluation
  rather than silently falling back to live.
- **Traceability.** Every book finding carries `evidence.ruleSet = { source: "live" | "snapshot",
snapshotId, routineId }`, and the `submitted` / `candidate_classified` / `candidate_corrected`
  workflow events record the same value.
- **Shadow.** `shadow_rule_snapshot_id` names a second snapshot that is evaluated alongside and
  logged as a `rule_shadow_evaluated` workflow event (its findings, the enforced findings, and the
  difference). Shadow output is never a review finding, so it can never block approval or close.
- **Promote and roll back.** Pinning the routine's shadow snapshot promotes it and clears the
  shadow; the previous snapshot stays for rollback. A pinned or shadowed snapshot cannot be
  deleted (`ON DELETE RESTRICT`).
- **Not yet covered.** Duplicate detection (`possible_duplicate`) runs on source records across
  routines and still reads the live config; the ledger scan runs against the posted ledger. Both
  are captured in a snapshot and replayed by the scorecard. System rules
  (`party_payment_details_changed`, `memory_conflict`, the source-processing rules) read no config,
  so no snapshot includes or switches them off.

### Rule scorecard

`bun eval:scorecard` replays a pile of papers under a rule set and prints the metrics: `cases`,
`real_problems_caught` (of `real_problems_total`), `false_alarms`, `approved_zero_edits`,
`locked_cases_passing` of `locked_cases_total`, Jev approvals a person would undo
(`jev_approvals_undone`, with per-lane agreement in `jev_lanes`), `memory_hit_rate`, and
`cost_per_100` (always null in recorded mode).

```text
bun eval:scorecard --pile golden --json                     # no network, no database
bun eval:scorecard --pile golden --rules <snapshot-id> --org <orgId>
bun eval:scorecard --pile org:<orgId> --rules live --limit 500
```

- `--pile` is a JSONL file, `golden` (`tests/evals/scorecard/golden.jsonl`), or `org:<orgId>` —
  the organization's most recently approved or rejected Inbox items, read-only inside its org
  context. `--rules` is `default` (catalog defaults), `live`, a snapshot id, or a JSON rules file.
  Only the `recorded` chain runs: `default` and `jev` would call live models, which is the nightly
  harness's job, not this command's.
- A pile line is one case: `id`, `category`, `locked`, `candidate` (`transactionDate`,
  `transactionType`, `originalCurrency`, `functionalCurrency`, `exchangeRate`), `lines` (amounts in
  the original currency, optional `categoryConfidence`), `accounts` keyed by the ids the lines
  use, `party`, `documents`, optional `duplicate` (`source` and `priorRecords` as
  duplicate-matcher inputs) and `ledgerHistory` (recent posted rows, for `material_expense`),
  `paymentDetails` (the payee's stored and printed bank details, for
  `party_payment_details_changed`), `expected` (`problems` — the rule keys of the paper's real
  problems — and optional `blocked`), `outcome` (`decision`, `edits`), and for a paper Jev
  proposed, `jev` (`kind`, and the lane's `threshold` and `amountCap` when it has them).
- **Jev lanes.** Each `jev` case is replayed through the approval checks for its lane (the case's
  party and `kind`; confidence is the weakest line `categoryConfidence`). `jev_lanes` gives each
  lane's agreement (approved unchanged / decided) and `jev_approvals_undone` counts papers Jev would
  approve that a person changed or rejected. Organization piles replay decided papers, not
  proposals, so they leave these empty: a lane's real agreement is in Settings → Jev approval.
- Organization piles take labels from `ai_eval_cases` rows with task `inbox_rules`,
  `input_ref.candidateId`, and `expected = { problems, blocked?, locked? }`; unlabeled cases count
  toward `cases` and `approved_zero_edits` only. They replay book rules; duplicate, ledger, and
  payee bank-detail context is not rebuilt.
- **CI gate.** `tests/evals/scorecard.eval.ts` runs the golden pile under
  `tests/evals/scorecard/golden-rules.json` in `bun run test:evals`, which CI's hermetic job runs,
  and fails unless every locked case reproduces exactly. Unlocked golden cases hold the known
  misses and false alarms the scorecard tracks.

## Export and import (v5)

Settings → Export / Import carries the Inbox's organization configuration since export version 5
(`src/lib/export-inbox.ts`, protocol in `.agent/rules/schema-export-import.md`): **Rule
Snapshots**, **Routines**, and **Classification Memories**. Older files import unchanged (the
v4 → v5 migration gives them empty lists). Import them in that order, after vendors, customers and
categories:

- **Rule snapshots** keep their label, content and exact creation time; import creates new rows
  (snapshots are never overwritten) and skips one already present with the same creation time,
  label and content.
- **Routines** never carry a signing secret — `routine_secrets` is not exported, nor even the
  `secret_ref` — nor runtime state (cursor, run times, last error). Pins are remapped onto the
  imported snapshots; a routine whose pinned snapshot is not there fails with "import Rule
  Snapshots first" rather than silently running on live rules. A signed webhook arrives
  **disabled**, with a note to generate a new secret and then enable it. A schedule arrives
  enabled only where the chart of accounts is applied. The organization's inbound email routine
  is never duplicated: if one exists, the imported one is skipped and the existing one is left as
  it was.
- **Memories** carry parties by name and accounts by number and name, remapped onto this
  organization's own; a memory whose party or account cannot be mapped (missing, inactive,
  ambiguous, or now a different kind of account) is **dropped and reported**. Counters and the
  on/off state come along — a memory that turned itself off arrives off. No `ai_eval_cases` lock
  is written for an imported memory, since its source paper is not part of the file.

Disabled routines and memories are always exported ("Include inactive records" does not filter
them), and every imported row writes an activity-log entry naming who imported it. Jev's approval
lanes are not part of the export yet; their evidence (`ai_run_feedback`) never will be.

## Inbound email

Each organization sets its exact inbound recipient in **Settings → Email → Inbound email**. Point
a Resend inbound-email webhook at:

```text
POST /api/inbound-email/resend
```

Configure `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`. Queued email and attachment jobs are
drained by a worker endpoint:

```text
POST /api/internal/worker
Authorization: Bearer <INBOX_WORKER_SECRET>
```

In production a Cloud Scheduler job calls it every minute; in development an in-process drain
runs instead (`JOB_DRAIN_MODE=inline`). If neither is active, inbound email is accepted and then
never processed — the jobs stay `queued` indefinitely. Deployment, the exact schedule, and the
"jobs are stuck" triage flow are in the
[job worker runbook](../internal-docs/infrastructure/job-worker.md); DNS and address setup are in
[Inbound Email Setup](../internal-docs/infrastructure/inbound-email-setup.md).

The worker downloads the email and attachments, stores evidence in the document vault, and leaves
the candidate for classification and review. The endpoint is safe to poll: it claims one queued
job at a time and retries failed jobs with backoff. A crashed final lease atomically marks the
job, ingestion event, source, Inbox item, finding, and audit event as failed. An exact webhook
replay can requeue that work only while the original failure and candidate are still open; it
cannot reopen an approved or rejected lifecycle.

**Multi-recipient delivery.** An email addressed to several organizations' inbound addresses is
delivered to every matched organization — each gets its own ingestion event, source record, Inbox
item, and processing job, and the webhook response lists every delivery. Attachment downloads are
bounded: the worker refuses attachments over 20 MB (the same ceiling as interactive uploads) and
abandons downloads after 60 seconds, recording the attachment as failed instead of pinning the
worker.

### Sender authentication

**Sender authentication (recorded decision):** the Resend/Svix signature proves that Resend sent
the webhook event — not who sent the email. The original decision stopped there because every
accepted email landed as a candidate a person had to approve. Jev approval lanes ended that
assumption: an email spoofing a known vendor's address, with the vendor's own bank details and
under a lane's cap, could otherwise have been posted by Jev. So the app judges the sender itself,
once, at ingest, and Jev approves an emailed paper only from a verified sender its party already
uses ([above](#jev-approval)):

- Resend's `email.received` webhook carries no authentication verdict, and the `headers` map its
  API returns keeps one value per header name — it cannot say which of several
  `Authentication-Results` came first, and a sender can write one of its own. The
  `process_inbound_email` job therefore reads the message's **raw header section** (Resend's raw
  download, only up to the blank line that ends the headers, at most 256 KB, 30-second timeout).
- Only the **topmost** `Authentication-Results` is believed — the receiving server prepends its
  own, so anything below it came from upstream, the sender included — and only when its
  authserv-id is the receiving server's (`TRUSTED_AUTHSERV_IDS` in
  `src/lib/inbox/sender-authentication.ts`). ARC results are not read: nothing here verifies their
  seals.
- **Passed** means, for the message's single plain From (it must also agree with the From Resend
  reports): DMARC pass with `header.from` equal to the From domain, or DKIM or SPF pass with a
  domain aligned with it (equal, or one a subdomain of the other). A missing, repeated or listed
  From, a missing or untrusted or unreadable header, or nothing aligned passing, is **not passed**.
- The verdict is stored on the email's source record as `raw_data.senderAuthentication`
  (`passed`, `reason`, `method`, the From, the authserv-id it saw, and each method's result). A
  failure to read the headers is recorded as not passed and never fails the job: it only means a
  person approves that email's papers.

Ingest still accepts any sender: an unverified email lands in the Inbox as before, for a person.
Per-org sender allowlists are tracked in [docs/audit-backlog.md](audit-backlog.md), not
implemented here.

**To confirm against live Resend traffic.** The guard rests on three things not yet seen on a real
message; until they are, treat it as provisional:

1. **The authserv-id.** `TRUSTED_AUTHSERV_IDS` is `amazonses.com`, on the assumption that Resend
   receives mail on Amazon SES. If Resend stamps another id, every emailed paper is held — never
   the reverse — and each recorded verdict names the id it saw (`authservId`), so one received
   message settles it.
2. **Every accepted message is stamped.** Believing the topmost `Authentication-Results` is sound
   only while the receiving server prepends its own to every message it accepts. One it let
   through unstamped would leave a sender's forged header on top — the one way this guard could
   fail open.
3. **The raw download.** The verdict is read from Resend's raw message download
   (`raw.download_url`) for received emails, header section intact and in order. If it is missing
   or cannot be read, the sender is not verified and the paper is held — never the reverse.

## Current integration boundary

Manual entry, both CSV importers, bills, scans and documents, inbound email, and signed webhooks
use the normalized source, ingestion, evidence, candidate, review, and ledger-linking foundation
described here. Provider OAuth and sync adapters for bank and card feeds, Ramp, Gusto, Stripe, and
other external systems remain separate connector work; they will arrive as integration or schedule
routines and enter through the same source-record and candidate pipeline.
