Here’s a **new implementation plan** for a **Philippine AI finance platform** built on a **Rust backend + API**, with **separate agents for Accounting/Bookkeeping and Tax Compliance**.

The key design choice is correct: **bookkeeping and tax compliance should not be the same agent**. They operate on different rules, different outputs, different risk profiles, and different approval flows. In the Philippines, that separation matters even more because filing/payment channels, invoicing rules, CAS/CRM/POS compliance, eBIRForms/eFPS flows, and e-invoicing obligations all sit in a regulatory layer that should not be mixed with the raw transaction-classification engine. The BIR’s current digital stack includes eFPS, eBIRForms, ORUS, the eTSPCert system, and rules around CAS/CRM/POS and electronic invoicing/electronic sales reporting. ([Bureau of Internal Revenue][1])

---

# Product vision

Build a **finance automation platform** with a shared ingestion and evidence layer, then route work into **two specialized agent systems**:

### 1. Accounting Agent

Purpose:

- ingest raw financial documents and transaction evidence
- classify and reconcile transactions
- draft journal entries
- maintain books and ledgers
- produce auditable bookkeeping outputs

### 2. Tax Compliance Agent

Purpose:

- consume normalized accounting outputs plus source evidence
- map transactions into Philippine tax treatments
- prepare tax views, compliance tasks, tax forms, invoicing/reporting checks, and submission packages
- flag filing/payment/compliance risks for approval

That separation gives you:

- cleaner system boundaries
- easier QA
- safer approvals
- better explainability
- ability to sell both as SaaS and as API

---

# Core architectural principle

Use a **modular multi-agent platform**, not one giant “do everything” model.

The system should have:

## Always-on kernel

- ingestion pipeline
- workspace/session store
- tool registry
- policy engine
- evidence store
- context engine
- event stream
- audit log
- approval workflow

## Runtime-pluggable services

- accounting agent runtime
- tax compliance agent runtime
- email ingestion adapter
- bank statement parser
- OCR/parser providers
- model providers
- memory providers
- rules engines
- human reviewer consoles

This keeps the Rust backend stable while letting you evolve each capability independently.

---

# High-level system architecture

## A. Shared platform layer

This is the layer both agents depend on.

### 1. Ingestion layer

Accept:

- uploaded bank statements
- sales invoices
- supplier invoices
- receipts
- collections reports
- expense claims
- payroll exports
- spreadsheets
- forwarded emails / parsed mailbox data
- CSV exports from ecommerce / POS / wallets / ERP
- manually encoded transactions

Because Philippine bank automation is often fragmented or unavailable, your ingestion strategy should assume **upload-first and email-first**, not bank-feed-first. The product wins by being excellent at turning messy evidence into normalized financial events.

### 2. Document intelligence layer

Convert raw files into structured evidence:

- file type detection
- OCR if needed
- table extraction
- line-item extraction
- metadata extraction
- merchant/supplier/customer extraction
- amount/date/tax extraction
- confidence scoring

Output:

- `DocumentEvidence`
- `ExtractedTransactionCandidate`
- `ExtractedCounterparty`
- `ExtractedTaxSignals`

### 3. Canonical ledger/event model

Create a shared internal data model:

- account
- counterparty
- transaction
- cash movement
- invoice
- bill
- expense
- journal entry
- tax code candidate
- attachment/evidence
- reconciliation link
- compliance obligation

Everything downstream should consume this canonical model, not raw PDFs.

### 4. Evidence vault

Immutable store for:

- original files
- parsed output
- model reasoning summary
- classification decision trail
- approval history
- linked transactions/forms

This is critical for accounting trust and tax defensibility.

### 5. Policy + approval engine

Every high-risk action should go through:

- confidence threshold
- business-rule validation
- optional human approval
- audit logging

Examples:

- auto-post bookkeeping entry only if confidence is high
- never auto-file tax without approval
- never overwrite final books silently
- never submit amended values without explicit signoff

---

# Agent separation

---

# I. Accounting / Bookkeeping Agent

This agent is your **books automation engine**.

## Mission

Transform messy financial evidence into:

- clean books
- reconciled accounts
- journal entries
- month-end accounting outputs
- exception queues for review

## What it should own

### 1. Transaction normalization

Convert raw signals from uploads/email/files into normalized financial events.

Examples:

- bank debit recognized as utility expense
- incoming transfer matched to customer payment
- supplier invoice converted into AP bill draft
- Grab/Shopee/Lazada CSV rows mapped into sales + fees + payouts

### 2. Chart of accounts mapping

Infer or apply:

- account code
- cost center
- project/client class
- department/classification
- counterparty
- payment method

### 3. Journal entry drafting

Produce:

- journal entry proposal
- supporting references
- confidence score
- explanation
- alternative classification suggestions when uncertain

### 4. Reconciliation

Core bookkeeping superpower:

- bank-to-ledger matching
- invoice-to-payment matching
- duplicate detection
- split transaction handling
- partial payment handling
- fee netting
- refund/reversal handling

### 5. Period close support

Prepare:

- unreconciled items
- missing documents
- suspicious classifications
- accrual suggestions
- prepaid/depreciation suggestions
- month-end close checklist state

### 6. Bookkeeping memory

Persist business-specific accounting behavior:

- preferred classifications for vendors
- recurring transaction mappings
- client-specific COA rules
- normal transaction patterns
- accountant overrides

This memory should be **accounting-specific**, not shared blindly with tax.

## Accounting agent tools

It should have tools like:

- `read_document`
- `extract_table`
- `classify_transaction`
- `match_transaction`
- `draft_journal_entry`
- `search_vendor_history`
- `search_prior_decisions`
- `post_to_staging_ledger`
- `request_human_review`
- `summarize_reconciliation_gap`

## Accounting outputs

- staged ledger entries
- reconciliation suggestions
- unreconciled exceptions
- accounting review packets
- monthly draft books
- evidence-linked audit trail

---

# II. Tax Compliance Agent

This agent is your **Philippine tax brain**.

## Mission

Transform accounting outputs + source evidence + regulatory rules into:

- tax treatment decisions
- filing obligations
- tax form drafts
- compliance status
- filing packages
- audit-ready substantiation bundles

## Why it must be separate

Bookkeeping asks:

- what happened economically?

Tax compliance asks:

- how should this be treated under BIR rules?
- what is reportable?
- what form is affected?
- what filing/payment deadline applies?
- what invoicing/reporting rule applies?
- what exception or exposure exists?

Those are different systems.

## What it should own

### 1. Tax treatment engine

Map normalized transactions into possible tax treatment buckets:

- VAT-related
- withholding-related
- income tax relevant
- percentage tax relevant
- exempt/zero-rated/special handling candidates
- document insufficiency flags

### 2. Compliance obligation engine

Generate and track:

- filing obligations
- payment obligations
- deadlines
- missing attachments/evidence
- required reconciliations before filing

### 3. Form/workpaper generation

Produce structured datasets for:

- tax return preparation
- schedules
- summaries
- support files
- internal compliance dashboards

### 4. Invoicing/reporting compliance checks

This is increasingly important. Recent BIR issuances around EOPT/electronic invoicing/electronic sales reporting affect which taxpayers and systems are in scope, including e-commerce taxpayers, large taxpayers, some CAS/CBA users with electronic invoicing, and exporters in certain contexts. ([BIR CDN][2])

This agent should detect:

- invoice data completeness issues
- document type mismatches
- sales reporting readiness
- unsupported invoice structures
- missing customer/VAT fields
- format issues for submission/export

### 5. eTSP / filing channel strategy

If you want to become infrastructure-grade in the Philippines, design the system so it can later support:

- eBIRForms workflows
- eFPS workflows
- eTSP integrations
- electronic invoicing / electronic sales reporting
- CAS/CRM/POS support surfaces

BIR’s eTSPCert system exists specifically for certified electronic tax software solutions and was expanded to cover more digital tax services. ([BIR CDN][3])

### 6. Tax compliance memory

Store:

- taxpayer registration profile
- tax type applicability
- filing habits
- prior tax positions
- approved treatment rules
- RDO/entity profile metadata
- recurring compliance exceptions

This memory must be controlled much more tightly than accounting memory.

## Tax agent tools

- `load_tax_profile`
- `load_bir_ruleset`
- `map_transaction_to_tax_treatment`
- `generate_workpaper`
- `check_deadlines`
- `validate_invoice_compliance`
- `prepare_return_dataset`
- `build_filing_packet`
- `request_tax_review`
- `generate_exposure_report`

## Tax outputs

- compliance calendar
- tax workpapers
- draft filing datasets
- exception/exposure queue
- submission bundles
- audit support packets

---

# Shared orchestration model

The right flow is:

## Stage 1: Ingest

User uploads files or grants email access.

## Stage 2: Extract

Documents become structured evidence.

## Stage 3: Accounting pass

Accounting Agent:

- classifies
- reconciles
- drafts books
- raises uncertainties

## Stage 4: Human/accountant review where needed

Approved entries become authoritative accounting outputs.

## Stage 5: Tax pass

Tax Compliance Agent consumes:

- approved ledger outputs
- invoice/evidence metadata
- entity tax profile
- regulatory ruleset

## Stage 6: Compliance review

Tax reviewer approves:

- workpapers
- filing packets
- exceptions

## Stage 7: Filing/export/submission

Depending on product maturity:

- export only
- assisted filing
- direct channel integration later

---

# API-first product design

Since you want this as both app and API, the backend should be exposed as task-oriented APIs.

## Main API surfaces

### Ingestion API

- upload files
- create ingestion jobs
- parse email payloads
- attach metadata
- create entity/workspace

### Accounting API

- run bookkeeping extraction
- classify transactions
- reconcile statement
- generate draft journal entries
- retrieve exception queue
- approve/reject classification

### Tax API

- generate compliance obligations
- compute tax views from approved books
- generate workpapers
- validate invoices/reporting readiness
- produce filing/export packets
- approve/reject tax treatment

### Review API

- fetch low-confidence items
- attach accountant/tax reviewer notes
- approve/revise
- escalate

### Audit API

- get source evidence chain
- get model decision summary
- get approval history
- get change history

---

# Recommended Rust backend architecture

Use a workspace with bounded modules:

```text
crates/
  finance-core/
  finance-ingest/
  finance-docintel/
  finance-ledger/
  finance-accounting-agent/
  finance-tax-agent/
  finance-policy/
  finance-memory/
  finance-context/
  finance-session/
  finance-audit/
  finance-rules-ph/
  finance-api/
  finance-worker/
  finance-email/
  finance-storage/
  finance-review/
```

## What each crate does

### `finance-core`

Canonical domain types:

- entity
- workspace
- transaction
- document evidence
- journal entry
- tax obligation
- approval state

### `finance-ingest`

Upload orchestration and job creation.

### `finance-docintel`

Parsing/OCR/table extraction/classification preprocessing.

### `finance-ledger`

Accounting domain rules and staged/final ledger mechanics.

### `finance-accounting-agent`

Accounting-specific orchestration, prompts, tools, memory, review thresholds.

### `finance-tax-agent`

Tax-specific orchestration, rules, validations, workpapers, filing bundles.

### `finance-policy`

Permissioning, confidence policies, auto-post rules, no-auto-file rules.

### `finance-memory`

Entity-specific persistent memory stores.

### `finance-context`

Build agent context from prior data, rules, entity profile, current period.

### `finance-session`

Task/session persistence.

### `finance-audit`

Evidence lineage and immutable audit records.

### `finance-rules-ph`

Philippine rules package:

- forms metadata
- obligations
- invoice/reporting validation rules
- taxpayer profile constraints
- future eTSP/e-invoicing mappings

### `finance-api`

Axum or Poem API.

### `finance-worker`

Background jobs and queue consumers.

### `finance-email`

Email connectors / parser ingestion pipeline.

### `finance-storage`

Blob/object storage and DB adapters.

### `finance-review`

Human-in-the-loop review services and reviewer UI contracts.

---

# Data sources you should support first

Given the Philippine reality, your first success comes from messy-but-common inputs.

## Priority 1

- PDF bank statements
- CSV bank exports
- emailed invoices/receipts
- uploaded purchase receipts
- sales invoice uploads
- spreadsheet transaction lists
- marketplace payout reports
- payment gateway exports

## Priority 2

- POS exports
- payroll exports
- wallet/e-money statements
- ERP/accounting CSV exports

## Priority 3

- direct partner integrations
- automated mailboxes
- future open banking-like integrations if available

---

# Email as a first-class ingestion channel

This is one of your strongest ideas.

Because bank connectivity is limited, email can become your semi-automation layer.

## Email ingestion use cases

- detect supplier invoices
- detect customer payment notifications
- detect billing emails
- detect official receipts/invoices sent by vendors
- detect bank alerts
- detect subscription renewals
- forward relevant evidence into ingestion queue

## Email architecture

Build:

- mailbox connector
- email parser
- attachment extractor
- transaction relevance classifier
- entity routing rules
- duplicate suppression
- approval queue for ambiguous emails

The email layer should not directly post entries. It should only produce structured evidence and candidate transactions for the Accounting Agent.

---

# Memory design

You specifically liked the terminology around memory/gateway/etc.

For this product, split memory into three levels:

## 1. Operational memory

Short-lived per run/session:

- current batch context
- current statement context
- unresolved matches
- current month close state

## 2. Entity memory

Long-lived business memory:

- preferred vendor mapping
- chart-of-account habits
- recurring transaction templates
- document source patterns
- tax registration profile
- reviewer overrides

## 3. Regulatory memory

Versioned rule memory:

- PH ruleset versions
- form mappings
- invoice/reporting validations
- filing applicability logic

Do not mix these into one blob.

---

# Context engine design

Each agent should have its own context engine.

## Accounting context engine includes

- recent transaction history
- prior classifications for same vendor
- current COA
- recent reconciliations
- entity bookkeeping preferences
- uploaded evidence in current batch

## Tax context engine includes

- approved accounting outputs
- entity tax profile
- current period obligations
- applicable PH ruleset version
- prior approved tax positions
- invoice/reporting compliance state

This keeps token usage tighter and outputs more reliable.

---

# Human-in-the-loop strategy

This part is non-negotiable for trust.

## Accounting review thresholds

Auto-post only when:

- confidence high
- pattern repeated
- amount within expected variance
- no policy conflict
- source evidence sufficient

Otherwise:

- stage for accountant review

## Tax review thresholds

Never fully auto-file in early versions.
Require review for:

- new tax treatment patterns
- large values
- amended positions
- incomplete documents
- filing-impacting exceptions
- uncertain invoice/reporting validation

This is how you earn trust and avoid reckless automation.

---

# Rules engine strategy

Use a hybrid of:

- deterministic business rules
- retrieval of PH regulatory rules
- LLM reasoning over evidence
- post-LLM validation

The LLM should **propose**, not directly become the final legal/accounting truth.

Pipeline:

1. extract facts
2. run deterministic validations
3. ask agent for classification/treatment proposal
4. validate proposal against rule engine
5. route to approval or acceptance

This is the right structure for finance.

---

# Gateway: do you need one?

Not at first.

For this product, a gateway is **optional in v1**.

Add it later if you want:

- multi-client control
- always-on background workers with live subscriptions
- mobile/web dashboard push updates
- remote operator console
- mailbox/webhook channel orchestration

Start with:

- REST API
- background job queue
- event stream/logs

Then add a gateway when the operational surface grows.

---

# Minimal v1 implementation plan

## Phase 1: core ingestion + accounting MVP

Build:

- entity/workspace creation
- file upload pipeline
- document parser
- PDF/CSV bank statement extraction
- transaction normalization
- vendor/customer extraction
- accounting agent for classification
- reconciliation engine
- staged journal entry generation
- reviewer queue
- audit trail

Goal:
“Upload your bank statement and supporting docs, get draft books and reconciliation suggestions.”

## Phase 2: email ingestion + bookkeeping automation

Build:

- mailbox ingestion
- attachment extraction
- relevance classifier
- duplicate suppression
- recurring transaction memory
- improved auto-classification
- reviewer feedback loop
- monthly close dashboard

Goal:
“Forward your finance emails and uploads, and the system continuously drafts bookkeeping work.”

## Phase 3: tax compliance engine

Build:

- taxpayer profile model
- obligation calendar
- tax treatment mapping
- workpaper generation
- invoice/reporting validation
- return dataset generation
- compliance exception dashboard
- tax reviewer workflow

Ground this in BIR’s actual digital environment: eFPS, eBIRForms, ORUS, eTSPCert, and evolving electronic invoicing/sales reporting obligations. ([EFPS][4])

Goal:
“From approved books, generate PH tax compliance outputs and reviewer-ready packets.”

## Phase 4: regulated integrations and infrastructure productization

Build:

- export packages for filing workflows
- eTSP-oriented architecture path
- invoicing/reporting integrations
- API product
- tenant isolation
- partner dashboards
- versioned PH rules engine
- enterprise approvals and audit controls

Goal:
“SaaS + API platform for accountants, firms, and embedded fintech providers.”

---

# Business packaging

You can package this as:

## SaaS

For SMEs, accountants, and accounting firms:

- upload docs
- get drafted books
- get compliance view

## Assisted operations platform

For your own service team:

- internal reviewer console
- batch processing
- client workspaces
- exception queues

## API

For fintechs, ERPs, payroll apps, ecommerce tools:

- send transactions/documents
- receive accounting/tax outputs
- embed compliance automation

That API angle is strong because the PH ecosystem is fragmented.

---

# Biggest product moat

Your moat is not just “AI.”

It is this combination:

- PH-specific ingestion reality
- evidence-linked bookkeeping
- separate tax compliance brain
- human-reviewable audit trail
- modular Rust backend
- API-first architecture
- future-ready path to BIR-aligned integrations

That is much harder to copy than a generic bookkeeping chatbot.

---

# Final recommendation

Build this as **two specialized agents on one shared finance platform**:

### Shared platform

- ingestion
- evidence vault
- canonical ledger model
- policy engine
- review workflow
- audit log
- context/memory system

### Agent 1

**Accounting Agent**
for classification, reconciliation, journal drafting, close support

### Agent 2

**Tax Compliance Agent**
for tax treatment, obligations, workpapers, filing packages, invoice/reporting validation

That is the correct foundation.

I can turn this next into a **full PRD + Rust crate blueprint + API endpoint design + database schema draft**.

[1]: https://www.bir.gov.ph/?utm_source=chatgpt.com "Bureau of Internal Revenue (BIR)"
[2]: https://bir-cdn.bir.gov.ph/BIR/pdf/RR%2011-2025%20Digest.pdf?utm_source=chatgpt.com "REVENUE REGULATIONS NO. 11-2025 issued on ..."
[3]: https://bir-cdn.bir.gov.ph/local/pdf/RMC%20No.%2064-2021.pdf?utm_source=chatgpt.com "Expanding the Electronic Tax Software Provider ..."
[4]: https://efps.bir.gov.ph/?utm_source=chatgpt.com "eFPS Home - eFiling and Payment System - BIR"
