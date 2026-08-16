# Multi-Provider AI + Finance Harness — Integration Plan

**Status:** Proposed (research + design). No code written yet — this is the plan to approve/scope before implementation.
**Goal:** Let the AI layer use OpenAI, Anthropic, Gemini, and open models (OpenAI- or Anthropic-compatible endpoints), behind one app-specific harness built for finance correctness — with **all provider credentials kept server-side and never leaked to the browser**.

---

## 1. Where we are today

Single provider (Gemini), reached through one client:

- **`src/lib/gemini-client.ts`** — `callWithRetry(opts, callFn)`. `callFn` receives a Gemini `GenerativeModel` and calls `model.generateContent(prompt)`. Sophisticated per-key round-robin with cooldown/exponential-backoff, health tracked in an in-memory `healthMap` (process-local — noted limitation under horizontal scaling).
- **`src/lib/ai-models.ts`** — model registry. Task categories `ocr | textAnalysis | imageGen`; every default is a Gemini model ID; per-task overrides stored in org metadata (`aiModelOcr`, `aiModelTextAnalysis`, `aiModelImageGen`).
- **`src/lib/org-metadata.ts`** — Zod schema for `auth_organizations.metadata`. Holds `geminiApiKeys: string[]` **in plaintext**, plus Stripe/PayPal/Resend secrets in plaintext.
- **8 call sites** (all server-side Nitro server fns, all under `withMutationPermissionOrgContext`):
  `-ai-date-parse`, `-ai-bill-ocr`, `-ai-transaction-parse`, `-ai-receipt-ocr`, `-ai-statement-ocr`, `-match-transactions`, `-ai-classify-document`, and `services/thumbnail-generator`.
- Each call site is **Gemini-coupled**: builds a `responseSchema` in Gemini's `SchemaType` shape, calls `generateContent`, then `result.response.text()`, strips ` ```json ` fences by hand, and `JSON.parse`s.

### Security posture today

| Control                                   | State                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI calls run server-only                  | ✅ all 8 sites are Nitro server fns                                                                                                                                                                                                                                            |
| Keys stripped from the org-hydration path | ✅ `useActiveOrganization.stripSensitiveMetadata()` strips `geminiApiKeys`                                                                                                                                                                                                     |
| Keys never logged in full                 | ✅ gemini-client logs only `orgId.slice(0,8)` + key index                                                                                                                                                                                                                      |
| **Settings endpoint hides secrets**       | ❌ **`getOrgSettings` returns `geminiApiKeys` raw**; `settings.tsx:992` loads them into browser state (`setKeys(settings.geminiApiKeys)`). Stripe/PayPal/Resend correctly return only `...Set: boolean`. **The Gemini keys are the exception — they reach the browser today.** |
| Secrets encrypted at rest                 | ❌ none — plaintext JSON in `auth_organizations.metadata`                                                                                                                                                                                                                      |

So the existing pattern (server-only keys, `...Set` booleans, `stripSensitiveMetadata`) is _right_ — it's just not applied consistently, and there's no at-rest encryption. The multi-provider work extends that pattern and closes both gaps.

---

## 2. Target architecture

Four layers, each replaceable:

```
 route / harness  ──►  aiComplete({ task, schema, input })   ← one façade the app calls
                              │
                       Task→Provider router  (ai-models.ts, extended)
                              │
                 ┌────────────┼─────────────┐
          AnthropicAdapter  OpenAIAdapter  GeminiAdapter      ← 3 shapes, official SDKs
                 │            │              │
         (baseURL override lets OpenAI/Anthropic adapters also
          drive "compatible" open models: vLLM, Ollama, OpenRouter, Together…)
                              │
                    Credential store (server-only, encrypted)
```

### 2.1 Provider abstraction — three _shapes_, not N providers

The key insight: "open models, OpenAI- or Anthropic-compatible" does **not** mean a new adapter per vendor. Both official SDKs accept a `baseURL` override, and virtually every open-model server speaks one of two wire formats:

- **OpenAI-shaped** (Chat Completions + `response_format` json_schema) → official `openai` SDK. One adapter serves OpenAI itself **and** vLLM / Ollama / OpenRouter / Together / LM Studio / Groq by swapping `baseURL` + `apiKey` + `model`.
- **Anthropic-shaped** (Messages + `output_config.format`) → official `@anthropic-ai/sdk`. Serves Anthropic **and** any Anthropic-compatible gateway via `baseURL`.
- **Gemini-shaped** → existing `@google/generative-ai`. Wrap the current `gemini-client.ts` unchanged as this adapter.

So the provider config is data, not code:

```ts
type ProviderKind = "anthropic" | "openai" | "gemini";
interface ProviderConfig {
  kind: ProviderKind;
  apiKey: string; // decrypted server-side at call time
  baseURL?: string; // set → an "OpenAI/Anthropic-compatible" open-model endpoint
  model: string; // e.g. "claude-opus-4-8", "gpt-…", "gemini-3-flash-preview", "llama-3.3-70b"
}
```

Common adapter interface:

```ts
interface LLMAdapter {
  generateStructured<T>(req: {
    schema: z.ZodType<T>;
    system?: string;
    input: LLMInput;              // text and/or images (OCR)
    maxTokens?: number;
  }): Promise<LLMResult<T>>;       // { data: T, usage, provider, model, raw }
  generateImage?(req): Promise<…>; // imageGen task (Gemini today)
}
```

Per the Anthropic SDK guidance, adapters use each vendor's **official SDK** — no OpenAI-compatible shims for Anthropic and vice-versa. `claude-opus-4-8` is the default Anthropic model unless the org picks otherwise.

### 2.2 One schema language: Zod (the crux of removing Gemini coupling)

Today every route hand-writes a Gemini `SchemaType` tree and hand-parses fenced JSON. Replace with **Zod as the single source of truth**:

- Define each task's output schema once in Zod (the app already uses Zod everywhere).
- Each adapter converts Zod → its own format at call time:
  - OpenAI/Anthropic ← `zod-to-json-schema` (JSON Schema) → `response_format` / `output_config.format`.
  - Gemini ← small `zodToGeminiSchema()` converter (Gemini takes an OpenAPI-subset schema), or reuse JSON Schema where Gemini accepts it.
- **Validation is provider-independent**: parse the raw response with the _same_ Zod schema. One place handles fence-stripping/coercion; routes stop doing it. A malformed provider response fails validation identically everywhere and can trigger the repair loop (§2.5).

This single change deletes ~8 copies of `SchemaType` trees + manual `JSON.parse` and makes outputs provider-agnostic.

### 2.3 Task → provider routing

Extend `ai-models.ts` so a task resolves to a `{ provider, model }` pair, not just a model string. Precedence unchanged in spirit:

```
explicit call override → org per-task setting → built-in default
```

- Keep `ocr | textAnalysis | imageGen` (add `matching` / `agent` later if useful).
- Built-in defaults stay Gemini (zero behavior change on day one).
- New org metadata: per-task `{ provider, model }`, plus per-provider credentials (§2.4). Settings UI gains a provider dropdown per task feeding the existing model dropdown.

### 2.4 Credential storage & the security model (the hard requirement)

**Constraint (verbatim, load-bearing): "we don't wanna leak credentials on client side."** Defense in depth:

1. **Server-only at every call.** All adapters run inside Nitro server fns; keys are read + decrypted server-side and never serialized into any response. (Already true for calls; keep it invariant.)
2. **Settings endpoints return masks, never secrets.** Fix `getOrgSettings`: replace `geminiApiKeys: string[]` with `geminiApiKeyCount: number` + masked previews (`"••••4a2f"`), matching the existing `stripeSecretKeySet` pattern. Same for new `openaiApiKeySet`, `anthropicApiKeySet`, and any compatible-endpoint key. Update `settings.tsx` to render "•••• last4 / Replace", never the full value. **This closes the current Gemini leak.**
3. **One sensitive-keys source of truth.** Extend `SENSITIVE_METADATA_KEYS` in `useActiveOrganization` to include every new provider key field (`openaiApiKey`, `anthropicApiKey`, compatible-endpoint `apiKey`), so the `getFullOrganization` hydration path keeps stripping them.
4. **Regression guard test.** A test that runs `getOrgSettings` + the org-hydration path and asserts no known-secret substring appears in the client-facing payload. This test would have caught today's Gemini leak; it prevents the next one.
5. **Encryption at rest (recommended, separable workstream).** Today all secrets sit in plaintext in `auth_organizations.metadata` — a DB dump / backup / log line exposes every org's provider + payment keys. Envelope-encrypt the secret fields only; decrypt just-in-time server-side. Given the app already ships **white-label per-client GCP deployments (Model C)**, the natural fit is **GCP Secret Manager** (keys out of the app DB entirely) or **GCP KMS** wrapping a per-org data-encryption key. Minimum viable fallback: AES-256-GCM with `SECRETS_ENCRYPTION_KEY` from env, storing `{ciphertext, iv, tag}`. (Decision point — see §5.)
6. **Never log secrets.** Adapters must redact keys from error paths (SDKs sometimes echo headers). Keep the gemini-client discipline.
7. **Third-party egress is new.** Today org data goes only to the org's own Gemini key. Sending finance docs to OpenAI/Anthropic means org data leaves to _those_ vendors. Two mitigations belong in the harness: a **PII-redaction pass** before egress (§2.5), and a **per-org provider allowlist** so a data-residency-sensitive client can pin "Gemini only" or "on-prem open model only."

### 2.5 The finance-specific harness

"A better way of handling finances" = the model _proposes_, deterministic accounting rules _dispose_. The harness wraps every AI call with finance-aware guardrails. It is **not** an open-ended agent loop — it's structured extraction + validation + bounded repair, matching the existing "propose suggestions, human/agent applies" model in reconciliation.

Responsibilities:

- **Grounding contract.** Caller passes the allowed entity sets (accounts, parties, departments, locations). The model may only return IDs from those sets; the harness post-validates every returned ID against the set and **blanks hallucinated IDs** (formalizing what `-ai-transaction-parse` already does ad hoc with `resolvePartyFromMappings`).
- **Accounting invariants** (deterministic, in TypeScript):
  - Journal entries balance: `Σdebit == Σcredit` within a rounding epsilon.
  - Amounts non-negative, ≤2 decimals, parse as valid decimals.
  - Dates fall in an open period — reuse the existing period-lock (`closedThrough`); never accept a date in a closed period.
  - Transaction-type ↔ line-shape consistency (`pay_out`→expense lines, `transfer`→from/to, `journal`→debit/credit pairs).
  - Referenced accounts have compatible types (a "bank/cash header" is actually an asset bank account).
- **Money math lives in code, never the model.** The model extracts line items and classifies; totals, tax, balancing, and currency rounding are computed with the existing money utilities. The model is never the source of truth for a derivable number.
- **Bounded repair loop.** On invariant violation, re-prompt once/twice with the _specific_ failure ("debits 500 ≠ credits 480 — fix the line items"). If still failing, return a **low-confidence proposal flagged for human review — never auto-apply.**
- **PII redaction pass** before third-party egress (mask account numbers/SSNs beyond last-4).
- **Confidence + provenance on every output**: which invariants passed, provider, model, tokens, cost, latency.
- **Invocation audit log** — new `ai_invocations` table (org, user, task, provider, model, tokens in/out, est. cost, latency, status, entity ref). Finance needs spend attribution + an audit trail; this also powers a cost dashboard.

Optional later: a bounded, deterministic tool surface (`lookupAccount`, `proposeJournalEntry`, `matchStatementLine`) if you want the reconciliation agent to become LLM-driven — the harness would normalize tool-call loops across Anthropic/OpenAI and execute tools server-side against the ledger, always producing proposals.

---

## 3. Phased plan

**Phase 1 — Abstraction, zero behavior change.**
Introduce `LLMAdapter` + the `aiComplete({ task, schema, input })` façade. Add Zod-schema adapters. Wrap the existing `gemini-client.ts` as `GeminiAdapter` (its rotation/backoff stays as-is). Migrate **one** route (`-ai-transaction-parse`) to the façade to prove the shape. Everything else untouched. _Ship + verify against current behavior._

**Phase 2 — Real multi-provider + security fixes.**
Add `openai` and `@anthropic-ai/sdk` + `zod-to-json-schema` deps. Implement `OpenAIAdapter` and `AnthropicAdapter` (with `baseURL` override → open models). Extend `ai-models.ts` and `org-metadata.ts` with per-task `{provider, model}` + per-provider keys. **Close the credential gaps:** mask secrets in `getOrgSettings`, extend `stripSensitiveMetadata`, add the regression-guard test, update the settings UI to masked/replace. Provider dropdown in settings.

**Phase 3 — Finance harness.**
Build validators, grounding contract, bounded repair loop, redaction pass, `ai_invocations` logging/cost tracking on top of the façade. Migrate the remaining 7 call sites onto harness + façade, deleting the per-route `SchemaType`/fence-parsing.

**Phase 4 — Hardening (recommended, separable).**
At-rest encryption (GCP Secret Manager / KMS per §2.4 decision). Move key-rotation health from in-memory `healthMap` to Redis for horizontal scale. Per-org provider allowlist for data-residency clients.

---

## 4. Dependencies & effort (rough)

| Item                        | New dep                    | Notes                                                       |
| --------------------------- | -------------------------- | ----------------------------------------------------------- |
| Anthropic adapter           | `@anthropic-ai/sdk`        | official SDK; default model `claude-opus-4-8`               |
| OpenAI + compatible adapter | `openai`                   | `baseURL` serves OpenAI + all OpenAI-compatible open models |
| Gemini adapter              | _(none)_                   | wraps existing `@google/generative-ai` client               |
| Zod → schema                | `zod-to-json-schema`       | + a tiny `zodToGeminiSchema()`                              |
| At-rest encryption          | GCP SDK _or_ node `crypto` | decision in §5                                              |

Phases 1–3 are the core; Phase 4 is independently schedulable. Each phase keeps lint/format/typecheck/tests green, same discipline as the audit branch.

---

## 5. Decisions for you (these change the plan)

1. **At-rest encryption approach** — recommend **GCP Secret Manager** (you already run per-client GCP Model C), alternatives are GCP KMS-wrapped DEK or env-key AES-256-GCM. Or defer to Phase 4.
2. **Harness scope** — recommend **validators + bounded repair loop** (propose-only, no open agentic loop) as the default. Full LLM tool-calling agent is a later option.
3. **Default provider** — keep **Gemini** as built-in default (zero day-one change), letting orgs opt into Anthropic/OpenAI/open per task? Recommended yes.
4. **Provider allowlist per org** — needed now (data-residency clients), or Phase 4?

---

## 6. Security checklist (acceptance criteria)

- [ ] No AI call runs client-side; all keys read + decrypted server-side only.
- [ ] `getOrgSettings` returns masks (`…Set` / `…Count` / last-4), never full keys — Gemini included.
- [ ] `SENSITIVE_METADATA_KEYS` covers every provider key field; `stripSensitiveMetadata` verified.
- [ ] Regression test asserts no secret substring in any client-facing org payload.
- [ ] Adapters redact keys from all error/log paths.
- [ ] (Phase 4) Secrets encrypted at rest; plaintext never persisted.
- [ ] PII-redaction pass runs before any third-party egress.
- [ ] (If chosen) per-org provider allowlist enforced server-side.
