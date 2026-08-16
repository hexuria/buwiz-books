-- Per-bank-account statement passwords, stored encrypted at rest.
-- Server-only table (like organization_secrets): NO row-level security policy —
-- it is protected by being read exclusively through server-side code that never
-- returns the ciphertext to clients. Do NOT add it to rls_policies.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS financial_account_secrets (
  financial_account_id uuid PRIMARY KEY
    REFERENCES financial_accounts(id) ON DELETE CASCADE,
  organization_id text NOT NULL
    REFERENCES auth_organizations(id) ON DELETE CASCADE,
  statement_password_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financial_account_secrets_org_idx
  ON financial_account_secrets (organization_id);

COMMIT;
