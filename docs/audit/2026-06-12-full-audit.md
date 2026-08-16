# Full Repository Audit - 2026-06-12

Scope: security, dependencies, code quality. Items marked [FIXED] are addressed in this MR; everything else needs follow-up.

## 1. Security

### HIGH - Payment API endpoints are unauthenticated

Files: `server/routes/api/payments/stripe-checkout.post.ts`, `paypal-order.post.ts`, `paypal-capture.post.ts`

None of these handlers verify a session or authorization. Anyone reaching the API can create checkout sessions for ANY `invoiceId` (invoice number, org name, and customer email are looked up server-side and embedded in the Stripe session - an enumeration / PII-leak vector) or call `paypal-capture` with an arbitrary `invoiceId`.

Remediation: if these are intended as public pay-your-invoice endpoints, gate them behind an unguessable pay-link token tied to the invoice; otherwise require an authenticated session plus org membership check.

### HIGH - `paypal-capture` marks invoices paid without verifying the payment

File: `server/routes/api/payments/paypal-capture.post.ts`

On capture status COMPLETED the invoice is set to `paid` with `amountPaid = invoice.total`, but the code never verifies that the PayPal order belongs to that invoice (no linkage check) or that the captured amount matches the balance due. An attacker can create and capture a minimal-value order, then mark any invoice fully paid.

Remediation: store the PayPal order ID against the invoice when created in `paypal-order.post.ts`, verify it on capture, and compare the captured amount against `balanceDue`. Prefer PayPal webhooks with signature verification as the source of truth.

### HIGH - Client-controlled redirect URLs in Stripe checkout

File: `server/routes/api/payments/stripe-checkout.post.ts`

`successUrl` / `cancelUrl` are taken straight from the request body and passed to Stripe, enabling phishing-style redirects after a legitimate payment. Remediation: ignore client-provided URLs and always derive them server-side from `BETTER_AUTH_URL` (the existing fallback already does this).

### MEDIUM - `src/lib/security-middleware.ts` is non-functional placeholder code

- `validateCSRFToken` passes when the CSRF token simply equals the session token - this is not CSRF protection.
- The CORS/origin check is an empty stub (comment: simplified version).
- `sanitizeInput` strips XSS with regexes, which is bypassable; output encoding / framework escaping should be relied on instead.
- `extractSecurityContext` reads fields that do not exist on real requests.

Remediation: delete this module or replace it with real middleware wired into the request pipeline. Its presence gives a false sense of security.

### MEDIUM - Debug script dumps live session tokens for a real user

File: `scripts/test-login.ts` queries sessions for a hardcoded personal email and prints raw session tokens. Combined with DB access this is a credential-exfiltration tool, and the hardcoded email is PII in the repo. Remediation: delete the script (also `scripts/test-auth-cookie.ts` and `scripts/get-hugo.ts` deserve review for the same pattern).

### LOW - Hardcoded developer-specific DB string

`package.json` script `db:test:reset` hardcodes `postgresql://uriah@localhost:5432/digits-tests`. Use an env var so the test DB works on any machine.

### INFO - `.env.example` leaks internal naming

Values like the R2 bucket `mvg` and gcloud config `mvgreenland` are real-looking internal identifiers. Consider neutral placeholders.

## 2. Dependencies

### HIGH - `nitro` pinned to `npm:nitro-nightly@latest`

An unpinned nightly is a supply-chain risk and makes builds non-reproducible; any nightly publish can break or compromise production. Remediation: pin to an exact nightly version or move to a stable nitro release.

### HIGH - `xlsx` ^0.18.5 has known unfixed CVEs

CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS) affect the npm-published SheetJS builds; no patched version is published to npm. Remediation: migrate to the vendor-distributed SheetJS CDN build (0.20.x) or switch to `exceljs`, and never parse untrusted spreadsheets without limits.

### MEDIUM - No lockfile committed, but Dockerfile requires one [FIXED in .gitignore]

`.gitignore` contains `*.lock`, which excludes `bun.lock`, yet the Dockerfile runs `bun install --frozen-lockfile` and `COPY package.json bun.lock ./`. Docker builds fail and dependency resolution is non-reproducible. This MR adds `!bun.lock` to `.gitignore`; you still need to `git add bun.lock` and commit it.

### LOW - `@types/sharp` is deprecated

`sharp` >= 0.32 ships its own types; remove `@types/sharp` from devDependencies.

## 3. Code quality

### MEDIUM - One-off debug scripts committed at repo root

`apply-attachments.ts`, `consolidate-ui.ts`, `clean-ai-chat.py`, `fetch-buckets.ts`, `rebuild-attachments.ts`, `reproduce_delete.ts`, `test-bucket.ts`, `test-db-url.ts`, `patch.txt`. These belong in `scripts/` (if still useful) or should be deleted. Not removed in this MR to avoid breaking unknown workflows - please confirm and delete.

### LOW - Committed artifacts and .gitignore inconsistencies

- `local.db` (empty SQLite artifact) was committed. [FIXED - removed, `*.db` now ignored]
- `EPICS/` is listed in `.gitignore` but its contents are committed - decide whether it is tracked or not.

### LOW - Editor/agent config sprawl

`.agent/`, `.agents/`, `.claude/`, `.windsurfrules`, `.github/workflows` (GitHub CI on a GitLab repo) - consolidate, and add a `.gitlab-ci.yml` if CI is expected to run here.

> **Superseded 2026-07-26.** The "GitLab repo" premise was wrong: the only remotes are
> GitHub (`codeitlikemiley/buwiz-books`, `goldcoders-corp/buwiz-books`). `.gitlab-ci.yml`
> existed but no runner ever executed it, so it was deleted rather than maintained. Do not
> re-create it. The findings above are left as the dated record they are.

### INFO - Docs duplication

`TESTING.md` and `TEST_SETUP_SUMMARY.md` overlap; `.stow-README.md` looks machine-specific.

## Summary of changes in this MR

1. Added this audit report.
2. Removed committed `local.db` artifact.
3. `.gitignore`: ignore `*.db`, un-ignore `bun.lock` so it can be committed for reproducible Docker builds.
4. `paypal-capture`: now verifies order/invoice linkage (`reference_id`) and that the captured USD amount covers the balance due before marking the invoice paid; invoice status is checked before capture.
5. `stripe-checkout`: success/cancel URLs are now derived server-side only (client-controlled redirect removed).
6. Deleted session-token-dumping debug scripts (`scripts/test-login.ts`, `scripts/test-auth-cookie.ts`, `scripts/get-hugo.ts`).
7. Deleted one-off debug scripts/artifacts at repo root (`apply-attachments.ts`, `consolidate-ui.ts`, `clean-ai-chat.py`, `fetch-buckets.ts`, `rebuild-attachments.ts`, `reproduce_delete.ts`, `test-bucket.ts`, `test-db-url.ts`, `patch.txt`).
8. `package.json`: removed deprecated `@types/sharp`; test DB URL is now overridable via `TEST_DATABASE_URL`.

## Remaining follow-ups (not fixed in this MR)

1. Decide the access model for the payment endpoints: public pay-link token vs authenticated session (endpoints remain unauthenticated; invoice-ID enumeration is still possible).
2. Pin or replace `nitro-nightly`; commit `bun.lock`.
3. Remove or rewrite `src/lib/security-middleware.ts` (verify nothing imports it first).
4. Replace `xlsx` or move to the patched SheetJS distribution.
5. Resolve `EPICS/` tracked-vs-gitignored inconsistency; consolidate agent/editor config dirs; add `.gitlab-ci.yml` if CI should run on GitLab.
6. Consider Stripe webhooks (with signature verification) as the source of truth for marking invoices paid, mirroring the PayPal recommendation.
