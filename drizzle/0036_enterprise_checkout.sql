-- Resumable, server-authorized Stripe Checkout reservations.

CREATE TABLE IF NOT EXISTS enterprise_billing_checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_account_id uuid NOT NULL REFERENCES enterprise_accounts(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  requested_quantity integer NOT NULL,
  external_price_id varchar(255) NOT NULL,
  external_customer_id varchar(255),
  customer_email varchar(320),
  success_url text NOT NULL,
  cancel_url text NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'creating',
  provider_session_id varchar(255),
  provider_session_url text,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_billing_checkout_sessions_status_check
    CHECK (status IN ('creating', 'open', 'completed', 'consumed', 'expired')),
  CONSTRAINT enterprise_billing_checkout_sessions_quantity_check
    CHECK (requested_quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS enterprise_billing_checkout_sessions_provider_unique
  ON enterprise_billing_checkout_sessions(provider_session_id)
  WHERE provider_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_billing_checkout_sessions_active_account_unique
  ON enterprise_billing_checkout_sessions(enterprise_account_id)
  WHERE status IN ('creating', 'open', 'completed');
CREATE INDEX IF NOT EXISTS enterprise_billing_checkout_sessions_account_created_idx
  ON enterprise_billing_checkout_sessions(enterprise_account_id, created_at);

-- Checkout URLs and reservation internals are server-only. With RLS enabled and
-- no runtime policy, request-scoped connections cannot inspect or mutate them.
ALTER TABLE enterprise_billing_checkout_sessions ENABLE ROW LEVEL SECURITY;

-- RLS does not govern TRUNCATE and must not be the only protection for URLs,
-- customer contact details, or the provider idempotency reservation. Normalize
-- every runtime role after any broad/default grants have run.
REVOKE ALL ON TABLE enterprise_billing_checkout_sessions FROM PUBLIC;

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE enterprise_billing_checkout_sessions FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;
