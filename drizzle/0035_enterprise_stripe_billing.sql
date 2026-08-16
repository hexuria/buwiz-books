-- Stripe-backed Enterprise entitlement reconciliation and webhook idempotency.

CREATE TABLE IF NOT EXISTS enterprise_billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_account_id uuid NOT NULL REFERENCES enterprise_accounts(id) ON DELETE CASCADE,
  provider varchar(24) NOT NULL DEFAULT 'stripe',
  external_customer_id varchar(255) NOT NULL,
  external_subscription_id varchar(255) NOT NULL,
  external_price_id varchar(255) NOT NULL,
  quantity integer NOT NULL,
  provider_status varchar(32) NOT NULL,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  last_provider_event_created_at timestamptz NOT NULL,
  last_provider_event_id varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_billing_subscriptions_provider_check CHECK (provider = 'stripe'),
  CONSTRAINT enterprise_billing_subscriptions_quantity_check CHECK (quantity > 0),
  CONSTRAINT enterprise_billing_subscriptions_period_check CHECK (current_period_end > current_period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS enterprise_billing_subscriptions_account_unique
  ON enterprise_billing_subscriptions(enterprise_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_billing_subscriptions_customer_unique
  ON enterprise_billing_subscriptions(external_customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_billing_subscriptions_subscription_unique
  ON enterprise_billing_subscriptions(external_subscription_id);

CREATE TABLE IF NOT EXISTS enterprise_billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id varchar(255) NOT NULL,
  event_type varchar(96) NOT NULL,
  provider_created_at timestamptz NOT NULL,
  enterprise_account_id uuid REFERENCES enterprise_accounts(id) ON DELETE SET NULL,
  status varchar(24) NOT NULL DEFAULT 'received',
  failure_code varchar(64),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT enterprise_billing_webhook_events_status_check
    CHECK (status IN ('received', 'processed', 'ignored', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS enterprise_billing_webhook_events_provider_event_unique
  ON enterprise_billing_webhook_events(provider_event_id);
CREATE INDEX IF NOT EXISTS enterprise_billing_webhook_events_account_received_idx
  ON enterprise_billing_webhook_events(enterprise_account_id, received_at);

ALTER TABLE enterprise_billing_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enterprise_billing_subscriptions_member_select
  ON enterprise_billing_subscriptions;
CREATE POLICY enterprise_billing_subscriptions_member_select
  ON enterprise_billing_subscriptions FOR SELECT
  USING (is_enterprise_account_member(enterprise_account_id));

-- Webhook delivery evidence is operator-only. With RLS enabled and no runtime
-- policy, a request-scoped connection cannot inspect or mutate provider events.
ALTER TABLE enterprise_billing_webhook_events ENABLE ROW LEVEL SECURITY;

-- RLS does not govern TRUNCATE, and a later/broader table grant can otherwise
-- expose operator evidence. Start from no table privileges, then grant only the
-- member-readable subscription SELECT capability below.
REVOKE ALL ON TABLE enterprise_billing_webhook_events FROM PUBLIC;
REVOKE ALL ON TABLE enterprise_billing_subscriptions FROM PUBLIC;

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE enterprise_billing_webhook_events FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON TABLE enterprise_billing_subscriptions FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT ON TABLE enterprise_billing_subscriptions TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;
