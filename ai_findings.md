# AI Usage Audit — Buwiz Books

Multi-agent audit of every AI touchpoint in the app (provider, models, data flow, keys, guardrails, failure modes, planned-vs-shipped). 78 sub-agents, 25 gap/risk findings survived adversarial verification (13 refuted claims excluded or corrected).

## The short answer

Buwiz Books uses AI for exactly one thing: turning unstructured financial documents and free text into structured accounting objects. Every AI call is a Google Gemini request made server-side through a single wrapper (`src/lib/gemini-client.ts:298`), with per-organization BYOK keys. Nine call sites across eight files (`grep callWithRetry src`) cover OCR of bills/receipts/bank statements, document-type classification, natural-language date and transaction parsing, field bounding-box detection, thumbnail image generation, and inbound-email attachment extraction. There is no chatbot, no agent loop, no RAG, and no tool-calling — every call is a single stateless request/response with a JSON response schema. The defining architectural characteristic is that **AI output is auto-applied far more often than it is human-confirmed**: only the receipt parse has a real Apply/Dismiss gate, and even that one writes database rows before the user sees the preview.

---

## Provider & models

**One provider, one SDK.** `@google/generative-ai` ^0.24.1 (`package.json:56`) is the only AI dependency in the repo. No OpenAI, Anthropic, or Vertex client exists.

All calls funnel through `callWithRetry(opts, callFn)` (`src/lib/gemini-client.ts:298`), which resolves a model, picks a key from the org's pool, and runs a caller-supplied callback against a `GenerativeModel`. The client builds **no prompts** — every prompt string lives at the call site.

**Model registry** (`src/lib/ai-models.ts:21`) — three task categories, six selectable models, five of which are `-preview` endpoints:

| Task           | Default model                    |
| -------------- | -------------------------------- |
| `ocr`          | `gemini-3.1-flash-image-preview` |
| `textAnalysis` | `gemini-3-flash-preview`         |
| `imageGen`     | `gemini-3-pro-image-preview`     |

Resolution order (`src/lib/gemini-client.ts:330-332`): explicit `opts.model` → per-task org override → legacy single org default → built-in default.

**How requests are made:**

- Structured output via Gemini native JSON mode — `responseMimeType: "application/json"` plus a `responseSchema` (e.g. `src/routes/api/-ai-bill-ocr.ts:405-406`).
- Multimodal inputs are base64-inlined into the request body (`inlineData`), not uploaded via the Files API (`src/routes/api/-ai-bill-ocr.ts:411-418`).
- `temperature` is set in exactly two places repo-wide: `0` in `src/lib/inbox/email-attachment-extraction.ts:190` and `0.1` in `src/routes/api/-ai-classify-document.ts`. Everything else uses API defaults.
- **No `safetySettings`, `systemInstruction`, `maxOutputTokens`, `topP`, or `topK` anywhere in the repo.** All generation runs on Gemini's default harm thresholds.
- Image generation relies on a `@ts-expect-error`-suppressed `responseModalities: ["Image"]` field the installed SDK doesn't type (`src/services/thumbnail-generator.ts:231-232`).

**Retry/rotation** (`src/lib/gemini-client.ts:30-33`): round-robin across keys, 3 failures per key, then exponential cooldown 1m ×3 capped at 6h; 1s/2s/4s backoff within a key. "Transient" is decided by substring-matching the error message (`:252-264`), not structured status codes — which works because the shipped SDK always interpolates the HTTP status into `.message` (`node_modules/@google/generative-ai/dist/index.js:434`). Genuine transport failures (`ECONNRESET`, `fetch failed`) fall through as fatal.

---

## Feature inventory

| #   | Feature                                                               | Server fn                                                                | Trigger                                                                   | Model?                                                                | Output handling                                                                              |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **Smart date filter** — natural-language date range on ~8 pages       | `parseNaturalDate` (`-ai-date-parse.ts:58`)                              | Enter / ⌘+Enter / "✨ Ask AI" button                                      | Yes, `textAnalysis`                                                   | **Auto-applied**; explanation card self-dismisses after 1.5s (`SmartDateFilter.tsx:240-245`) |
| 2   | **AI transaction composer** — free-text → double-entry lines          | `parseTransactionPrompt` (`-ai-transaction-parse.ts`)                    | ⌘+Enter, submit button, **or `?aiPrompt=` URL param auto-submit**         | Yes, `textAnalysis`                                                   | **Auto-applied to form**, comment says deliberately (`AIChatPanel.tsx:82-84`)                |
| 3   | **Receipt "Parse with AI"** — attachment → prefilled transaction      | `parseReceiptDocument` (`-ai-receipt-ocr.ts:293`)                        | Explicit per-attachment button                                            | Yes, `ocr`                                                            | **Human-confirmed** (Apply/Dismiss/Re-parse) — the only one                                  |
| 4   | **Entity resolver** — creates parties/COA accounts/financial accounts | `resolveExtractedEntities` (`-ai-entity-resolver.ts:87`)                 | Chained silently from #3, before the user sees Apply                      | **No model at all** — pure DB read/create despite the `-ai-` filename | **Auto-applied**, writes rows                                                                |
| 5   | **Bill drag-drop pipeline** — file → vendor + bill                    | `parseBillDocument` (`-ai-bill-ocr.ts:296`)                              | File drop; modal closes immediately                                       | Yes, `ocr`                                                            | **Fully auto-applied**: creates vendor party + bill, no preview                              |
| 6   | **Field bounding boxes** — overlays on document viewer                | `extractBoundingBoxes` (`-ai-bill-ocr.ts:472`)                           | "Scan Fields" / "Re-scan" buttons; one call **per PDF page**              | Yes, `ocr`                                                            | Auto-persisted to `documents.ocrBoundingBoxes`                                               |
| 7   | **Bank statement OCR** — statement → reconciliation lines             | `parseStatementDocument` (`-ai-statement-ocr.ts:219`)                    | Statement upload on reconciliation page                                   | Yes, `ocr`                                                            | **Auto-applied end-to-end**: overwrites balances, inserts lines, auto-matches                |
| 8   | **Document classification**                                           | `classifyDocument` (`-ai-classify-document.ts:24`)                       | **Fire-and-forget on every non-deduplicated upload** — zero UI disclosure | Yes, `textAnalysis`                                                   | **Auto-written** to `documents.documentType`                                                 |
| 9   | **AI thumbnail**                                                      | `regenerateThumbnailWithAI` (`thumbnail-generator.ts:339`)               | Purple "AI" button; requires org opt-in flag                              | Yes, `imageGen`                                                       | Auto-applied; soft-fails                                                                     |
| 10  | **Inbox email attachment extraction**                                 | `ensureEmailAttachmentExtraction` (`email-attachment-extraction.ts:183`) | **Background queue worker** — no human in the loop                        | Yes, `ocr`                                                            | Parks candidates at `needs_information`/`ready_for_review`; **never posts to ledger**        |

**Named "AI" but isn't:** `/review-agents` runs deterministic SQL + standard-deviation math (`src/lib/inbox/review-engine.ts:66-70`, `:181`); `-ai-entity-resolver.ts` makes no model call; `-party-suggestions.ts` uses hardcoded scores (`:74`, `:112`, `:143`); `runAutoMatcher` is a rules engine gated at confidence 85 (`src/lib/auto-matcher.ts:60`).

**Auto-apply count: 8 of 9 model-backed features apply without confirmation.**

---

## Data flow — what actually leaves the app

**Whole file bytes go to Google.** Bills, receipts, bank statements, and payslips are base64-inlined into the request body:

- `src/routes/api/-ai-bill-ocr.ts:411-418`
- `src/lib/inbox/email-attachment-extraction.ts:196-201` (`input.fileBuffer.toString("base64")`)
- `src/routes/api/reconciliations/-_statement-upload.ts:486-495` — re-downloads from R2 and re-sends the full file

**Org master data goes with it.** The receipt prompt sends the full chart of accounts **with database IDs**, parties with IDs, departments, and locations, and instructs the model to return those IDs (`-ai-receipt-ocr.ts:306-320`). The transaction-parse prompt does the same (`-ai-transaction-parse.ts:308-310`) — and those lists are supplied by the **client**, not read from the DB.

**Prompts explicitly request identifiers:**

- Account last-4: `"If only masked digits shown (e.g. ****1234), extract '1234'"` (`-ai-statement-ocr.ts:105-107`)
- Card last-4: `"Visa ending 7744"... identifier: the last 4 digits` (`-ai-receipt-ocr.ts:375-376`)
- Bank routing/account numbers (`-ai-bill-ocr.ts:378`) — though this is a **dead instruction**: `billOcrSchema` (`:118-283`) has no bank-identifier property, so structured output gives it nowhere to land.
- `account_number` bounding box: `"text = the full or masked account number"` (`-ai-bill-ocr.ts:543`) — this one **does** persist verbatim, unencrypted, to `documents.ocrBoundingBoxes`.

No prompt anywhere requests a full card number.

**What comes back is cached in plaintext** on the org-scoped `documents` table: `ocrBoundingBoxes` (`src/db/schema/documents.ts:91-100`), `metadata.billOcr`, `metadata.inboxExtraction` (`:103-130`), and `aiTransactionCache` (`:132-141`). That table does have an RLS policy declared (`drizzle/rls_policies.sql:122`) — see the caveat in Gaps.

**What does not leave:** the date parser sends only the user's typed query plus today's date (`-ai-date-parse.ts:72-75`). The AI thumbnail sends only title + document type, no file bytes (`thumbnail-generator.ts:221-225`). The classifier sends only the filename — the sole caller passes no `contentPreview` (`-documents.ts:377`).

---

## Keys & configuration

**BYOK, per-organization, no env fallback.** Keys live in a server-only `organization_secrets` table (`src/db/schema/auth.ts:104`), one row per org, holding an **array** of Gemini keys plus Resend/Stripe/PayPal secrets. The schema carries an explicit warning: _"Better Auth returns organization metadata to browser clients, so credentials must never be stored in auth_organizations.metadata."_

`src/lib/gemini-client.ts:166-167` states there is deliberately **no env var fallback** — zero keys throws `"No Gemini API keys configured. Go to Settings → AI Credentials to add your keys."` (`:303`). `GEMINI_DEFAULT_MODEL` is documented in `.env.example:36-38` but read nowhere, and its comment names a model three generations stale.

**Client exposure is closed.** `getOrgSettings` masks keys to `••••last4` before returning them (`-org-settings.ts:117`); the write path maps masks back to stored plaintext so an unchanged mask doesn't clobber the real key (`:282-287`). Org metadata is re-serialized through a zod schema with no secret fields, so unknown keys are stripped (`src/lib/org-metadata.ts:7-30`). The built client bundle contains no key material.

**Write requires admin/owner** (`organization:update` + `assertOrgAdmin`, `-org-settings.ts:248-253`). **Read of the masked payload requires only org membership** — no admin check (`:93-97`).

**Encryption at rest: none.** `gemini_api_keys` is plain `jsonb`; `stripe_secret_key`, `stripe_webhook_secret`, `paypal_client_secret`, `resend_api_key` are plain `text` (`src/db/schema/auth.ts:108-112`). `drizzle/0018_integrity_and_server_secrets.sql:6-16` creates them without pgcrypto. Repo-wide grep for `createCipheriv|SECRETS_ENCRYPTION_KEY|KMS|SecretManager` returns zero hits.

---

## Guardrails & failure modes

**What is enforced:**

- Every AI endpoint is a `createServerFn` behind `withMutationPermissionOrgContext` with a same-origin check, permission check, and per-route rate limit keyed `routeKey:orgId:userId` (`src/lib/request-guards.ts:112`). Limits: 20/5min for all file-bearing routes, 30 for transaction-parse and entity-resolve, 60 for date-parse.
- Rate limits are bypassable outside production via `BYPASS_RATE_LIMITS=true` (`request-guards.ts:100-104`).
- **Input** is zod-validated on most routes, often twice.
- Bill OCR results are cached per document under a chart-of-accounts context hash, guarded by a Postgres advisory lock (`-ai-bill-ocr.ts:318-334`).
- `validateStatement` runs seven checks — classification, org-name fuzzy match, account type, account last-4, period overlap, balance integrity, transaction count (`src/lib/statement-validator.ts`) — and has **16 unit tests**, the best-tested AI-adjacent code in the repo.
- Inbox candidates stop at `needs_information`/`ready_for_review`; posting requires `approveInboxItem`, which enforces separation of duties (`src/lib/inbox/service.ts:800-803`) and a duplicate-matcher gate (`:843-849`).
- `createTransaction` hard-rejects any account/party/department/location ID that doesn't belong to the org **before any row is written** (`src/lib/inbox/service.ts:217-219, 248-250, 278-293`). This is the real backstop for client-supplied context lists.

**What is not enforced:**

- **Model output is never runtime-validated** on the five main parse routes. Each does a bare `JSON.parse` and a TypeScript cast: `-ai-statement-ocr.ts:302`, `-ai-receipt-ocr.ts:454`, `-ai-bill-ocr.ts:434` and `:606`, `-ai-date-parse.ts:102`, `-ai-transaction-parse.ts:394`. Gemini's `responseSchema` is treated as a guarantee. The bounding-box call doesn't even set a `responseSchema` (`-ai-bill-ocr.ts:576-580`) yet persists its output.
- **No request timeout, deadline, or `AbortSignal`** anywhere in the Gemini path. `const result = await callFn(model)` (`gemini-client.ts:339`) is awaited unguarded inside `while(true)` × 3 retries.
- **No token or cost accounting.** `usageMetadata`, `promptTokenCount`, `totalTokenCount` appear nowhere in the repo.
- Successful calls emit **no telemetry**. The only log line in `gemini-client.ts` is a cooldown warning (`:118-123`).

**When AI is down or has no key:**

| Path                         | Behavior                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document classification      | Graceful — returns `{documentType: "other", confidence: 0}` (`-ai-classify-document.ts:115-122`); doc stays as uploaded                               |
| Bounding boxes               | Graceful — returns `[]`, viewer shows no highlights (`-ai-bill-ocr.ts:622`)                                                                           |
| Thumbnails                   | Graceful — automatic path is Sharp/pdf-to-img/SVG, **never uses AI** (`thumbnail-generator.ts:259`)                                                   |
| Inbox worker                 | Graceful — records `extractionError` as data, keeps processing (`inbox-worker.post.ts:274`)                                                           |
| Document intake              | Graceful — queues rather than fabricating a zero-fact candidate; **covered by an integration test** (`tests/integration/document-intake.test.ts:398`) |
| Attachment panel             | Graceful — reuses `aiTransactionCache`                                                                                                                |
| **Reconciliation statement** | **Hard fail** — both upload and re-OCR rethrow (`-_statement-upload.ts:153`, `:496`). No manual-entry fallback in that flow                           |
| All keys rate-limited        | `GeminiRateLimitError` with ETA + workaround: "go to /documents, and upload file" (`gemini-client.ts:52`)                                             |

---

## Gaps & risks (verified only)

Everything below survived adversarial verification. Refuted claims are excluded; where a claim was overstated I state the corrected, narrower version.

### CRITICAL — SHIPPED

**1. A live Gemini API key sits in `.env.test`, and the repo's own `.gitignore` does not cover it.**
`.gitignore` lines 7-10 list only `.env`, `.env.cloudrun`, `.env.cloudrun.yaml`, `.env.production`. `.env.test` is excluded solely by `/Users/uriah/.gitignore_global:8`. Any collaborator cloning without that machine-local config gets `.env.test` as an untracked file ready to commit. **Rotate the key and add `.env.*` + `!.env.example` to the repo `.gitignore`.**

**2. `scripts/seed-superuser.ts:48-55` writes a Gemini key into browser-visible `auth_organizations.metadata`** — the exact field migration 0018 exists to scrub. Better Auth's `/organization/list` returns raw org rows to any authenticated member (including low-privilege `member` and `client_approver`), and `src/lib/auth.ts` marks no field `returned:false`. The repo states this threat model itself at `src/hooks/useActiveOrganization.ts:22-23`. Worse: `db:reset` uses `drizzle-kit push --force`, which applies the Drizzle schema rather than the numbered SQL files — **so 0018's scrub never runs on a fresh database and only the seed's write lands**. `.env.test` contains a live key and `db:test:fresh` runs the seed, so every `bun test:e2e` plants a real key in browser-visible metadata. Script is unmodified since `8f708de`, predating hardening commit `1a55ff4`.

### HIGH — SHIPPED

**3. No encryption at rest for any org credential.** Gemini keys, Stripe secret key, Stripe webhook secret, PayPal client secret, Resend key — all plaintext (`src/db/schema/auth.ts:108-112`; `drizzle/0018:6-16`). A DB dump, Neon branch, read replica, logical backup, or SQL-injection read primitive yields every tenant's live payment and AI credentials.

**4. Privilege escalation via `-ai-entity-resolver.ts`.** Gated on `document:upload` (`:87-90`) but inserts into `parties` (`:217`), `accounts` (`:314`), and `financialAccounts` (`:328`). The `member` role has `document: ["view","upload"]` but only `party: ["view"]`, `account: ["view"]`, `financialAccount: ["view"]` (`src/lib/permissions.ts:94-105`). **There is no model in the loop** — it's a plain DB-write endpoint accepting a client-supplied entity array, so nothing constrains the input. A member can mint parties and GL accounts they otherwise cannot create.

**5. Statement validation is computed but never enforced, and the client banner is triple-dead.**

- `validateStatement` is called exactly once, at `-_statement-upload.ts:436`, and its result gates nothing — lines insert unconditionally at `:523-547`.
- The server returns it under key `validation` (`:674`); the client reads `result.validationResult` (`useReconciliationMutations.ts:172`) — always `undefined`.
- Even if the key matched, it filters on `c.status`, but `ValidationCheck` exposes `passed`/`severity` (`statement-validator.ts:21-28`).
- The banner JSX (`ReconciliationDocumentViewer.tsx:377-385`) lives inside the `!imageUrl && !pdfDataUrl` empty state, which disappears once a document attaches.
- `runStatementOcr` (`:696`) never calls `validateStatement` at all.

Net: a statement for the wrong account, wrong org, or with a broken balance chain silently populates a reconciliation. The validator has 16 passing unit tests and is wired to nothing.

**6. `classifyDocument` mutates document type from raw model output with no confidence gate, no UI disclosure, and no undo.** Writes whenever the answer isn't `"other"` (`-ai-classify-document.ts:105-112`); `confidence` is requested (`:79`) and logged (`:102`) but never persisted or compared. Fired unawaited on every non-deduplicated upload (`-documents.ts:377-387`). Three aggravating facts: the call passes no `contentPreview`, so it is a **filename-only guess**; `AttachmentsPanel.tsx:150-157` uploads with an explicit human-set `documentType: "receipt"` that the classifier can overwrite; and `documentType` drives the `missing_receipt` / `missing_invoice` review rules (`review-engine.ts:130`, `:139-144`). A misclassification silently changes which financial controls fire.

**7. The receipt-parse flow writes master data before the user reviews anything.** `AttachmentsPanel.tsx:434-440` chains into `resolveExtractedEntities` inside the parse handler — parties, COA categories, and financial accounts are created before the Apply button renders. The one feature with a real human gate isn't actually gated.

### MEDIUM — SHIPPED

**8. No request timeout or `AbortSignal` on any Gemini call.** With N keys, worst case is 3N SDK round trips plus 3s of sleep per key, and a hung HTTP request never resolves. Grep for `AbortController|signal:|timeout` in the AI path returns nothing.

**9. An invalid or revoked key is never removed from rotation.** Non-transient errors deliberately skip the failure counter (`gemini-client.ts:344-347`), so a 403 `API key not valid` never calls `recordFailure`. `pickNextAvailableKey` keeps handing that key out on its round-robin turn forever — 1-in-N requests fail permanently until someone edits settings.

**10. Zero token/cost accounting on a BYOK integration that inlines whole documents.** Route limits cap call _count_, not tokens. A few large multi-page PDFs can dominate an org's Gemini bill with no per-org spend visibility, quota, or anomaly detection.

**11. Config-load failure is indistinguishable from "not configured."** `gemini-client.ts:223-225` swallows every exception with a bare `catch` returning an empty key list, which feeds the `:303` "go add your keys" error. A transient DB outage tells an already-configured org to re-enter credentials — and nothing is logged.

**12. Model output is never runtime-validated on the OCR routes**, and the unvalidated JSON flows into DB writes: `statement_lines` amounts/dates, reconciliation balances, `documents.metadata.billOcr`, `documents.ocrBoundingBoxes`. _Corrected scope:_ 5 of 7 parse sites — `-ai-classify-document.ts:115-122` and `extractBoundingBoxes` (`-ai-bill-ocr.ts:621-623`) do degrade gracefully. Note that `src/lib/inbox/email-attachment-extraction.ts:204` uses a zod `.parse` but the file contains **zero** try/catch, making it the most exposed parse in the codebase, not the model to copy.

**13. Fresh receipt OCR results are not scrubbed against real org IDs.** `validateCachedResult` (`AttachmentsPanel.tsx:34-51`) strips unknown `categoryId`/`partyId` — but only on the **cache** branch (`:400`). Fresh parses go straight into state at `:464`. The downstream `createTransaction` org check catches it, so this is a UX defect (fields look filled until save fails), not a ledger-integrity one.

**14. `ilike()` wildcard leakage.** `-ai-entity-resolver.ts:192` and `:271-275` pass OCR-derived strings directly as LIKE patterns with no escaping of `%` or `_`. A vendor name containing those characters silently matches an unrelated record.

**15. No file-size limit on the statement OCR path.** Client checks mime type only (`ReconciliationDocumentViewer.tsx:171-176`), `uploadBankStatement` raw-casts with no zod (`-_statement-upload.ts:327-336`), and `parseStatementDocument`'s schema is `z.string().min(1)` (`-ai-statement-ocr.ts:201`). Contrast `-bills.ts:1215`, which does cap. `mimeType` also reaches `PutObjectCommand` `ContentType` with no allowlist, then gets cast into the `documents.fileType` enum at `:388`.

**16. All AI endpoints are gated on `document:upload` regardless of what they do.** This both over-grants (any member drives the entity resolver's writes) and under-grants (`clientApprover` has `document: ["view"]`, so the read-only AI date filter fails with an authorization error rather than being hidden).

**17. `getOrgSettings` requires membership, not admin** (`-org-settings.ts:93-97`). Any member or client_approver can enumerate the org's AI key count and each key's last 4 characters, plus `taxId`, Stripe publishable key, and which secrets are set — data every write path in the same file guards behind `assertOrgAdmin`. Same pattern in `-connections-payments.ts:40-42`.

**18. Residual pre-0018 exposure window.** Better Auth's org endpoints are mounted (`server/routes/api/auth/[...all].ts:30`) and return raw metadata to any authenticated member, and `gemini-client.ts:189-206` still falls back to metadata keys. In any deployment where 0018 hasn't run — or a restored pre-0018 backup — keys are browser-readable. _(Note: the fallback itself is server-only and correctly labeled; the claim that it "reads keys out of the browser" was refuted. Its real defect is that it emits no warning when it fires, so operators can't tell they're on the legacy path.)_

**19. Bill drag-drop creates a vendor and a bill from one file drop with no preview.** The modal closes immediately (`BillUploadModal.tsx:61-62`) so the user cannot cancel. Vendor dedup is exact case-insensitive equality (`bill-upload-store.ts:221-223`), so "Acme Inc" vs "Acme, Inc." mints a duplicate vendor master record. Mitigation: the bill lands in `in_review`, and GL posting still needs a human state transition.

**20. Whole multi-page PDFs are sent inline in a single request**, and the viewer path issues one Gemini call per preview page in a serial loop (`-documents.ts:1211-1231`). _Corrected:_ fan-out is capped at 20 model calls per 5-min window by `extractBoundingBoxes`'s own `ai:bounding-boxes` guard (`-ai-bill-ocr.ts:477-480`), which increments per page. The residual defect is that the loop still iterates and R2-downloads every page past the cap, and pages beyond 20 silently yield no boxes (error logged only).

**21. Rate limits and key health are process-local Maps** (`request-guards.ts:16-20`, `gemini-client.ts:67-73`), both self-documented. Cloud Run deploys with `--max-instances=3` (`.github/workflows/deploy.yml:139-141`), so the effective per-user limit multiplies by replica count. _Corrected:_ this does **not** defeat the cooldown design — each replica converges independently, so the cost is bounded amplification (worst case 3×3 wasted calls per key) and latency, not leaked 429s.

**22. Zero test coverage of the production key source.** Every test — unit and integration — seeds keys via `organization.metadata` (`tests/unit/gemini-client.test.ts:56`, `tests/integration/ai-statement-ocr.test.ts:89`), i.e. the transitional fallback. `getOrganizationSecrets` is the untested primary path. Deleting the fallback would break the tests while leaving the real path uncovered.

**23. The e2e AI test asserts nothing.** `tests/e2e/transactions/new/ai-attachment.spec.ts:30` looks for a button matching `/scan|auto-fill/i`; the real label is `✨ Parse with AI` (`AttachmentsPanel.tsx:765`). The conditional body never executes — permanently green regardless of whether the feature works.

**24. `bun run test:integration` loads `.env.test`, opening the `GEMINI_API_KEY` describe gate** and making real billable calls against a live Postgres as soon as anyone points `AI_OCR_FIXTURES_DIR` at real fixtures. No cost ceiling, no cassette/replay layer. _(These suites never run in CI — `deploy.yml`'s test job env has only `DATABASE_URL`, `TEST_DATABASE_URL`, `BETTER_AUTH_SECRET`.)_

**25. No regression guard on client-facing org payloads.** Only metadata-schema stripping is tested (`tests/unit/lib/org-metadata.test.ts:15-22`); `getOrgSettings`/`getPaymentGatewayConfig` output is untested. Grep of `tests/` for `org-settings` returns zero files.

### LOW — SHIPPED

- **No safety settings anywhere.** A `SAFETY` block returns an empty candidate that `thumbnail-generator.ts:237-238` reports as a generic parse failure.
- **Five of six model IDs are `-preview` endpoints**, and the org-selected value is a free-form string with no membership check against `AI_MODEL_OPTIONS` (`gemini-client.ts:209-221`).
- **`GEMINI_DEFAULT_MODEL` is dead config** and its comment names a model three generations stale (`.env.example:37-38`).
- **`parseBillDocument` raw-casts its payload** (`-ai-bill-ocr.ts:303-309`) including `documentId`, which builds an advisory-lock key with no uuid check — unlike its sibling `extractBoundingBoxes` (`:96-101`). _Corrected:_ not unique — `uploadBankStatement` (`:320`) and `runStatementOcr` (`:696`) share the pattern, and the zod-validated siblings have no `.max()` either, so a validator alone wouldn't bound payload size.
- **Mask round-trip collision:** `currentByMask` is keyed on the last 4 chars (`-org-settings.ts:282-287`), so two keys sharing a last-4 collapse to one Map entry. Any save — including an unrelated model-dropdown change, which resubmits `keys` (`settings.tsx:1053-1064`) — would overwrite one live key with a duplicate.
- **Key removal has no confirmation dialog and no Save gate** (`settings.tsx:1036-1045`), on a hover-revealed button. Since keys reach the browser masked, an accidental delete is unrecoverable — the user must reissue at Google. The same file uses `confirm()` for member removal (`:1723`).
- **Misleading UI copy:** `settings.tsx:1121` says "No API keys configured. Using environment variable fallback." No such fallback exists (`gemini-client.ts:166-167`); AI features hard-fail.
- **`?aiPrompt=` auto-submits an LLM call on page load** (`transactions_.new.tsx:168` → `AIChatPanel.tsx:95-106`). The form isn't saved automatically, limiting blast radius.
- **Entity resolver failures return HTTP 200 with a partially-resolved list** (`-ai-entity-resolver.ts:130-137`), and the UI wraps the whole call in `} catch {}` (`AttachmentsPanel.tsx:462`).
- **`runStatementOcr` deletes all statement lines, flags, and suggestions** scoped only by `reconciliationId` (`-_statement-upload.ts:771-780`); the ledger-generated path at `:1316-1325` is identical. _Corrected:_ no manual data is lost — nothing in the repo ever writes `source: 'manual'` or `'generated'`, and no shipped code edits a line's date/description/amount. What is destroyed is the user's match/unmatch/ignore decisions. Separately, `uploadBankStatement`'s narrower `source='generated'` delete (`:505-513`) matches **zero rows**, so re-uploading appends duplicate `ocr` lines and leaves stale flags.
- **Synthetic ledger-generated statement lines are mislabeled** `source: "ocr"` with `ocrConfidence: "1.0"` (`:1338-1339`) despite never touching a model.
- **Unit suite burns ~12s of real wall-clock** in `setTimeout` backoffs (measured: 12046ms for 4 tests, 9019ms for one). `vi.useFakeTimers()` would cut this to ms and make cooldown-expiry testable.
- **Integration tests leak a Postgres connection** (no `sql.end()`) and call a migration helper whose body is commented out (`tests/utils/db-utils.ts:29`).
- **`tests/integration/ai-receipt-ocr.test.ts:220`** asserts `/^\\d+\\.\\d{2}$/` — a double-escaped regex that can never match a decimal string. Would fail the moment fixtures exist. (Three sibling double-escaped regexes in `ai-statement-ocr.test.ts:137,138,141` are harmless dead code, since structured output returns unfenced JSON.)

---

## PLANNED, not shipped

`AI_MULTIPROVIDER_PLAN.md` describes a multi-provider architecture. **None of it exists in code:**

| Planned                                              | Status                                                   |
| ---------------------------------------------------- | -------------------------------------------------------- |
| OpenAI / Anthropic adapters                          | Not shipped — `@google/generative-ai` is the only AI dep |
| `aiComplete()` / `LLMAdapter` façade                 | Not shipped — zero grep hits                             |
| Zod as single schema language (`zod-to-json-schema`) | Not shipped — no dependency                              |
| `ai_invocations` audit table                         | Not shipped — no table, no migration                     |
| PII redaction before third-party egress              | Not shipped                                              |
| Per-org provider allowlist                           | Not shipped                                              |
| `{provider, model}` routing pairs                    | Not shipped — registry stores bare model strings         |
| Encryption at rest                                   | Not shipped (plan §4, `:119`)                            |
| Client-payload regression guard test                 | Not shipped (plan `:118`)                                |

**The plan document is itself materially stale** and will mis-scope work if used as-is. It declares "No code written yet" (`:3`), describes the Gemini-key-to-browser leak as live (`:26`), and cites `stripSensitiveMetadata()` and `SENSITIVE_METADATA_KEYS` helpers that no longer exist — all superseded by the `organization_secrets` table and masking. Its still-valid items are exactly four: **encryption at rest, the regression test, PII redaction, and the provider allowlist.**

---

## If you fix five things

1. **Rotate the `.env.test` key and add `.env.*` to `.gitignore`** — a live credential is one `git add .` from a public repo.
2. **Fix `scripts/seed-superuser.ts:48-55`** to write to `organization_secrets` — every fresh environment and every e2e run currently plants a real key in browser-visible metadata, and `drizzle-kit push` means 0018's scrub never runs.
3. **Re-gate `-ai-entity-resolver.ts`** on `party:create` / `account:create` — it's a plain write endpoint wearing an AI filename.
4. **Wire up `validateStatement`** — rename the client's `validationResult` → `validation`, filter on `passed`/`severity`, move the banner out of the empty state, call it from `runStatementOcr`, and gate the inserts. The validator is already correct and well-tested; it just isn't connected.
5. **Add a confidence gate and a `documentType` provenance column** before `classifyDocument` overwrites human-set values — a filename-only guess currently decides which financial controls fire.
