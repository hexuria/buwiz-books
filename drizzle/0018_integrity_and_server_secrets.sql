-- Integrity and secret-storage hardening.
-- This migration is intentionally transactional: either every invariant is installed
-- and credentials are scrubbed from browser-visible metadata, or nothing changes.
BEGIN;

CREATE TABLE IF NOT EXISTS organization_secrets (
  organization_id text PRIMARY KEY
    REFERENCES auth_organizations(id) ON DELETE CASCADE,
  gemini_api_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  resend_api_key text,
  stripe_secret_key text,
  stripe_webhook_secret text,
  paypal_client_secret text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill credentials before removing them from Better Auth metadata.
INSERT INTO organization_secrets (
  organization_id,
  gemini_api_keys,
  resend_api_key,
  stripe_secret_key,
  stripe_webhook_secret,
  paypal_client_secret
)
SELECT
  id,
  CASE
    WHEN jsonb_typeof(COALESCE(metadata, '{}')::jsonb -> 'geminiApiKeys') = 'array'
      THEN COALESCE(metadata, '{}')::jsonb -> 'geminiApiKeys'
    ELSE '[]'::jsonb
  END,
  COALESCE(metadata, '{}')::jsonb ->> 'resendApiKey',
  COALESCE(metadata, '{}')::jsonb ->> 'stripeSecretKey',
  COALESCE(metadata, '{}')::jsonb ->> 'stripeWebhookSecret',
  COALESCE(metadata, '{}')::jsonb ->> 'paypalClientSecret'
FROM auth_organizations
WHERE COALESCE(metadata, '{}')::jsonb
  ?| ARRAY[
    'geminiApiKeys',
    'resendApiKey',
    'stripeSecretKey',
    'stripeWebhookSecret',
    'paypalClientSecret'
  ]
ON CONFLICT (organization_id) DO UPDATE SET
  gemini_api_keys = CASE
    WHEN organization_secrets.gemini_api_keys = '[]'::jsonb
      THEN EXCLUDED.gemini_api_keys
    ELSE organization_secrets.gemini_api_keys
  END,
  resend_api_key = COALESCE(organization_secrets.resend_api_key, EXCLUDED.resend_api_key),
  stripe_secret_key = COALESCE(
    organization_secrets.stripe_secret_key,
    EXCLUDED.stripe_secret_key
  ),
  stripe_webhook_secret = COALESCE(
    organization_secrets.stripe_webhook_secret,
    EXCLUDED.stripe_webhook_secret
  ),
  paypal_client_secret = COALESCE(
    organization_secrets.paypal_client_secret,
    EXCLUDED.paypal_client_secret
  ),
  updated_at = now();

UPDATE auth_organizations
SET metadata = (
  COALESCE(metadata, '{}')::jsonb
    - 'geminiApiKeys'
    - 'resendApiKey'
    - 'stripeSecretKey'
    - 'stripeWebhookSecret'
    - 'paypalClientSecret'
)::text
WHERE COALESCE(metadata, '{}')::jsonb
  ?| ARRAY[
    'geminiApiKeys',
    'resendApiKey',
    'stripeSecretKey',
    'stripeWebhookSecret',
    'paypalClientSecret'
  ];

ALTER TABLE journal_headers
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS journal_headers_org_idempotency_key_unique
  ON journal_headers (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS journal_headers_org_source_document_idx
  ON journal_headers (organization_id, source_document_type, source_document_id);

-- Abort with a useful error instead of silently choosing one of conflicting rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM reconciliations
    GROUP BY organization_id, bank_account_id, period_start, period_end
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate reconciliation periods exist; resolve them before migration 0018';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM statement_lines
    WHERE matched_journal_line_id IS NOT NULL
    GROUP BY matched_journal_line_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'journal lines are matched more than once; resolve them before migration 0018';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS reconciliations_org_account_period_unique
  ON reconciliations (organization_id, bank_account_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS reconciliations_org_status_idx
  ON reconciliations (organization_id, status);

CREATE INDEX IF NOT EXISTS statement_lines_reconciliation_idx
  ON statement_lines (reconciliation_id);

CREATE UNIQUE INDEX IF NOT EXISTS statement_lines_matched_journal_line_unique
  ON statement_lines (matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;

COMMIT;
