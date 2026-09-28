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

A Bills-editor bill already exists when its item is approved, and a reviewer
may have corrected the entry in the Inbox first. Approval accrues it through
the same core, which brings the bill in line with what posts — amount, balance
due, line items, vendor, bill date and number (its terms stay as set) — in the
approval's transaction, under the same A/P-shape and whole-cent rules. The bill
can also be approved, scheduled, paid, voided or deleted on the Bills page while
its Inbox item is still pending. Those actions already post, cancel or remove
its accrual, so approval refuses, with nothing written, a bill that was deleted,
voided, already accrued from Bills (approving would post it twice), or has
payments recorded; reject such an item instead.

## Inbox v2 (per-organization preview)

Admins can turn on the new Inbox under **Settings → General → New Inbox**
(`inboxV2` in the organization's metadata; off by default). Both screens read
the same Inbox items, so switching moves no data and open items carry over.

- The list holds only what needs a person: items with details to fill in or
  ready for review, and failed ones; never approved, rejected, or dismissed.
  Papers still being read (received or processing) need nobody yet, so they are
  not listed: a quiet "N papers being read" line counts them. The sidebar's
  Inbox badge is the list's length.
- Each item carries one reason, first match wins: **Failed** (the item failed,
  or its source could not be processed), **Needs a fix** (an open blocking check,
  or an entry still missing lines or accounts), **Jev unsure** (a real
  model-unsure signal), **Spot check** (a paper Jev would have approved, held
  back for a person — see Jev approval lanes below), and otherwise **Ready to
  approve** — a clean entry, typed by hand or read confidently. On a lane at
  suggest, a ready paper Jev would approve says so.
- Jev is unsure when a line carries a low-confidence category, or when stage 2
  could not use its answer: a category below the threshold or with no usable
  answer (kept in the line's prediction evidence), or a counterparty it left
  unresolved (on the `candidate_classified` event for the current revision). A
  confident "no fit" or "new party" is an answer, not a doubt. Stage 2 parks such
  a category on Uncategorized and leaves such a counterparty empty, so the doubt
  surfaces as an `uncategorized` or missing vendor/customer check; that check
  alone makes the item Jev unsure, not Needs a fix. Anything the doubt does not
  explain still needs a fix — today that includes the payment side, which stage 2
  never picks, so a freshly classified paper reads Needs a fix and its strip
  names the doubt after the check ("… Jev isn't sure about the category (41%
  sure)."). A reviewer's saved correction replaces the system's lines and
  revision, so the doubt ends there.
- The reading pane is the real editor, prefilled: vendor bills open in the Bills
  editor, everything else in the New transaction editor on its tab. Its Save
  runs the candidate correction and the book checks; Approve first saves any
  unsaved edits the same way, then approves through the shared posting cores.
  Approve stays off while a blocking check is open.
- Bill lines have Department and Location pickers, as the New transaction
  editor's journal and paid-for lines do, so the Missing Department and Missing
  Location checks clear when a reviewer picks them and saves, rather than
  needing a resolution note. On a bill they post on the accrual's expense lines
  and on the bill's own lines.
- Keyboard: `j` / `k` move, `a` approves, `r` rejects with a reason, `e` jumps
  into the editor. Shortcuts are ignored while typing.
- A sales invoice from a paper is booked as an entry; approval does not create
  an invoice record yet.
- A correction keeps each line's counterparty: payable and receivable lines
  take the entry's vendor or customer, and other lines keep the party they had
  unless the correction names one.
- An entry a classification memory answered carries a **Remembered** badge. With
  no check blocking it, it reads Ready to approve ("Answered from a correction
  you asked Jev to remember…"); disagreeing memories read Needs a fix, named by
  their `memory_conflict` check.
- After a save that changed the answer (accounts, counterparty, or kind of
  paper), the pane offers **Remember this?** above the editor; approving with
  such a change offers it in a corner card once the approval lands. Both are
  optional and block nothing. Settings → Review Rules lists the memories.

## Jev approval lanes

Jev may approve Inbox papers itself once it has earned it, one **lane** at a
time: one vendor or customer and one kind of paper (`ai_autonomy_lanes`,
migration 0060). Settings → **Jev approval** lists the lanes; admins change it.

- **Levels.** A lane is created at **watch** the first time Jev proposes a paper
  for it. Admins promote it to **suggest** (the Inbox says when Jev would
  approve) and then to **auto** (Jev approves), one step at a time. Each
  promotion re-checks, at that moment, that 200 of Jev's own answers on the
  lane were reviewed with at least 98% accepted unchanged (`AUTONOMY_CRITERIA`,
  counted over the lane's own labels). Auto also needs the lane's vendor or
  customer (the lane for papers with no known party can never approve), an
  amount cap, and a confidence threshold the lane's calibration supports. After
  every new label, an auto lane whose last 50 labels fall below 95% drops back
  to suggest by itself, and a lane in that state is not promoted.
- **Remembered answers.** A paper a classification memory answered (build step 10) is a proposal too, recorded as the memory's, with a confidence of 1. Its
  label counts toward the lane's agreement and its demotion — a lane at auto
  approves remembered answers as well — but not toward promotion or
  calibration, which are about Jev: a remembered answer replays a person's fix,
  has no model confidence, and counting it would let a lane earn authority Jev
  never showed. So a vendor whose every paper is remembered never earns a lane;
  its papers wait, one click from approval, for a person. The memory keeps its
  own count as well: Jev approving its answer unchanged confirms it, and an undo
  of that approval counts against it (two in a row turn it off).
- **Labels.** A proposal is a draft stage 2 answered (a category it picked at
  or above the threshold) or a remembered answer. It is recorded with its lane
  after classification (`jev_proposal_recorded`), and the first person's
  decision on it becomes the lane's label (`ai_run_feedback.lane_id`):
  approved unchanged — date, currency, counterparty, and every line's account,
  side and amount that Jev answered — is **accepted**; any change is
  **corrected**; a rejection, or an undo of Jev's own approval, is
  **rejected**. Filling what Jev left blank (the payment side) is not a
  correction. Each label records whether Jev _would_ have approved the paper, so
  Settings and the scorecard show agreement per lane.
- **Calibration.** Labels are bucketed by Jev's confidence. The threshold may not
  sit below the lowest bucket from which every observed bucket up was accepted
  at least 98% of the time on at least 30 labels.
- **When Jev approves.** Only when every condition holds: the lane at auto; the
  organization's switch on (**Let Jev approve Inbox papers**, off by default);
  the AI kill switch off; maker-checker (`requireDifferentApprover`) off, or an
  admin opted Jev in; confidence at or above the lane's threshold; no open
  blocking check or warning; no duplicate case; a known counterparty and none
  being created; no change to a payee's bank details, ever; for a paper that
  came in by email, a verified sender (below); an open period; every line on an
  account and balanced; the total at or under the lane's cap; and the paper not
  sampled as a spot check. Anything else leaves it in the Inbox, and a
  `jev_auto_approval_held` event says why. A paper is decided when it is
  proposed: promoting a lane or turning the switch on does not approve papers
  already waiting in the Inbox.
- **Emailed papers: a verified sender, always.** A paper whose source is an
  inbound email — or an attachment or the body of one — is approved by Jev only
  if **every** message behind it passed sender authentication and came from a
  sender the paper's party already uses. _Passed_ means the receiving server's
  own `Authentication-Results` says DMARC pass for the From domain, or DKIM or
  SPF pass aligned with it. _Already uses_ means the From domain is the domain
  (or a subdomain of the domain) of the party's stored email, or of a paper of
  that party a person approved; at a shared mailbox provider (gmail.com,
  outlook.com, yahoo.com and the like) only the exact address counts, since
  anyone can sign up there. Missing, repeated or unreadable authentication data is not a pass:
  the paper stays in the Inbox as **Sender could not be verified — Jev won't
  approve this on its own**, with the reason in its `sender_unverified` hold.
  Webhook-routine papers are not email (each request is HMAC-signed) and are
  unaffected. How the verdict is captured: see _Sender authentication_ under
  Inbound email.
- **Spot checks.** A share of what Jev would approve (10% by default, set in
  Settings) is decided before posting — a hash of the candidate id and the
  organization's salt — and left in the Inbox as **Spot check**. The person's
  decision is an unbiased label.
- **How it posts.** The `jev_auto_approve` job decides again under the paper's
  lifecycle lock and approves through the same approval and posting cores as a
  person. Jev is recorded as the system actor: `review_decisions.actor_type` is
  `system` with `actor_key` `jev` and no `actor_id`; `inbox_items.resolved_by`
  stays empty (a user column never borrows a person); the journal's
  `created_by`, the bill's `approver_id` and the activity rows say
  `system:jev`, and the activity log names the lane, the confidence and the rule
  snapshot. Entries Jev approved show a **by Jev** tag in Bills and
  Transactions.
- **Undo.** On the entry screen, **Undo Jev approval** (needs Inbox approve)
  posts a reversal — never a delete — dated like the original, or today when
  that period is closed; voids the bill it created (refused once anything was
  paid); returns the paper to the Inbox on a new revision; counts as a
  disagreement for the lane; and, when a memory answered the paper, counts an
  undo against that memory.
- **Categories.** `categorize` stays structurally manual
  (`STRUCTURAL_MANUAL_KINDS`) for per-kind autonomy and every other path; the
  inbox_approve lane alone may apply the category of a paper it approves
  (`INBOX_APPROVE_LANE_EXCEPTIONS` in `src/lib/ai/autonomy.ts`, with the reasons
  and guards). Stage 2 never picks the payment side, so a paper stage 2 alone
  read is never complete enough to approve; a remembered answer (build step 10)
  can make it so.

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

The payment side (bank, card, cash, AP, or AR) is left for the reviewer unless a
memory answers it (below). With Jev opted in, Jev answers both picks first and
Gemini is the fallback.

### Memories ("Remember this?")

After correcting a draft, a reviewer who can approve Inbox items may choose
**Remember this?** and a scope: this file (the document's sha256), this sender
(sender email plus printed tax id), this party, or these words (the
description's alias-normalized tokens). The prompt first shows how many papers
from the last 12 months the scope would have matched, and how many of them it
would have changed. Scopes that can answer more than one party's papers — these
words, or a sender without a party — need `agentRule:configure` (owners and
admins). A memory stores the kind of paper, the party, and each line's account;
never bank or payment details, and nothing is written to the party.

Stage 2 consults memories **before any model**, most specific first (file,
sender, party, words). A hit writes the remembered answer with no model call at
all; the book rules and the payment-details check still run on it, so blocking
findings still block. A memory's accounts and party must pass the same checks as
a model's pick (active leaf accounts of this organization, still of the type
they had, a party of the right kind); one that fails is skipped and reported on
the memory. Two memories of the same specificity that disagree apply nothing and
raise the blocking `memory_conflict` finding. When a remembered answer settles
the whole entry — every line has an account, the counterparty is set where the
kind of paper has one — and no finding blocks approval, the item moves to ready
for review exactly as a reviewer's correction would leave it; otherwise it stays
in needs information. Remembered payable and receivable lines carry the entry's
counterparty, as a correction writes them.

A correction away from a memory's answer before approval — or a reversal or void
of the posted entry — counts as an undo; an answer approved as-is resets the
count. Two undos in a row turn the memory off. Everyone who can see the Inbox can
list memories (uses, undos, whether one turned itself off, and why it would be
skipped today); owners and admins can turn them on or off or delete them. Every
save also writes an `ai_eval_cases` row (`authored`, task `inbox_memory`);
replaying it must reproduce the answer exactly. CI's recorded evals replay every
authored case in `tests/evals/fixtures/inbox-memory-locks.json`
(`tests/evals/memory-lock.eval.ts`).

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
established by the Resend/Svix signature — that proves Resend sent the event,
not who sent the email. The original decision stopped there because every
accepted email landed as a candidate a person had to review. Jev approval lanes
(above) end that assumption: an email spoofing a known vendor, with the vendor's
own bank details and under the lane's cap, could otherwise be posted by Jev. So
the app now judges the sender itself, once, at ingest:

- Resend's `email.received` webhook carries no authentication verdict, and the
  `headers` map its API returns keeps one value per header name — it cannot say
  which of several `Authentication-Results` came first, and a sender can write
  one of its own. The `process_inbound_email` job therefore reads the message's
  **raw header section** (Resend's raw download, only up to the blank line that
  ends the headers, at most 256 KB, 30-second timeout).
- Only the **topmost** `Authentication-Results` is believed — the receiving
  server prepends its own, so anything below came from upstream — and only
  when its authserv-id is the receiving server's (`TRUSTED_AUTHSERV_IDS` in
  `src/lib/inbox/sender-authentication.ts`: `amazonses.com`, on the assumption
  that Resend receives on Amazon SES; if that is wrong, every emailed paper is
  held, never the reverse, and each verdict names the id it saw). This relies
  on the receiving server stamping every message it accepts — one it let
  through unstamped would leave the sender's own header on top. ARC results
  are not read.
- The message must have exactly one plain From, and it must agree with the From
  Resend reports. DMARC pass needs `header.from` equal to the From domain; DKIM
  and SPF count when their domain is aligned (equal, or one a subdomain of the
  other).
- The verdict is stored on the email's source record as
  `raw_data.senderAuthentication` (`passed`, `reason`, `method`, the From, the
  authserv-id and each method's result). A failure to read the headers is
  recorded as not passed and never fails the job: it only means a person
  approves the email's papers.

Ingest still accepts any sender: an unverified email lands in the Inbox as
before, for a person. Per-org sender allowlists are tracked in
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
`locked_cases_total`, Jev approvals a human would undo (`jev_approvals_undone`,
with per-lane agreement in `jev_lanes`), and `memory_hit_rate` / `cost_per_100`
(null until memory lands, and always null in recorded mode).

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
  `blocked`), `outcome` (`decision`, `edits`), and for a paper Jev proposed,
  `jev` (`kind`, and the lane's `threshold` and `amountCap` when it has them).
- **Jev lanes.** Each `jev` case is replayed through the approval checks for its
  lane (the case's party and `kind`; confidence is the weakest line
  `categoryConfidence`). `jev_lanes` gives each lane's agreement (approved
  unchanged / decided) and `jev_approvals_undone` counts papers Jev would
  approve that a person changed or rejected. Organization piles replay decided
  papers, not proposals, so they leave these empty: a lane's real agreement is
  in Settings → Jev approval.
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
