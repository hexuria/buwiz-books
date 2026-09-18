# Offline mock AI (`AI_MODE=mock`)

Use this when you want to click through AI features (date parse, OCR, ingest
triage, match assist, …) without spending provider tokens and without any
outbound Gemini / Anthropic / OpenAI HTTP.

This is an **in-process runtime swap**, not an HTTP Chat Completions mock.
OCR and other `DOCUMENT_TASKS` are Gemini-only in production
(`enforceOcrPolicy`); a fake OpenAI-compatible server cannot cover them.
`AI_MODE=mock` short-circuits `aiComplete` before adapters, credentials, or
spend checks.

## Run locally

```bash
# one-shot
AI_MODE=mock bun run dev

# equivalent package script
bun run dev:mock
```

Or set `AI_MODE=mock` in `.env` (see `.env.example`). Unset it, or set
`AI_MODE=live`, to use the production runtime again.

You do **not** need org API keys in Settings → AI Credentials for mock mode.
`prepare()` always returns a synthetic hop so callers never hit
`AiNoCredentialsError`.

## What it covers

Every `AiTaskName` in `src/lib/ai/types.ts` has a canned JSON string in
`src/lib/ai/fixtures/mock-responses.ts` that passes that task's Zod schema:

| Task                                                                                                                                                          | Notes                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `date_parse`, `transaction_parse`, `bill_ocr`, `statement_ocr`, `classify_document`, `ingest_triage`, `match_assist`, `coa_draft`, `category_mapping_suggest` | Seeded from the recorded eval corpus                  |
| `receipt_ocr`, `bbox_scan`, `form_2307_ocr`, `email_extraction`, `txn_prefill`, `reflection`                                                                  | Minimal schema-valid JSON (no recorded eval case yet) |

The façade still redacts the prompt, parses with the live Zod schema, and
applies grounding. IDs in canned payloads that are not in the caller's
`allowedIds` are blanked the same way live output would be.

## Flip back to live

Unset `AI_MODE`, or set `AI_MODE=live`. Behavior matches production: org
settings, spend caps, credentials, and the Gemini-first chain.

## Production guard

`AI_MODE=mock` **throws at module init** when `NODE_ENV=production`. The error
tells the operator to unset `AI_MODE` (or set `AI_MODE=live`). Do not ship
mock mode on Cloud Run.

## Out of scope

- HTTP mock of `/v1/chat/completions` (a later follow-up)
- Changing OCR policy to allow non-Gemini providers
- Loading fixtures from `AI_MOCK_FIXTURES_PATH` (not required for this slice)
