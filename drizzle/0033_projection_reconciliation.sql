-- Durable shadow-read evidence used to prove projection parity before cutover.
-- Financial values remain tenant-scoped under the same direct-membership RLS
-- boundary as the reporting projection itself.

CREATE TABLE IF NOT EXISTS business_group_projection_reconciliation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES auth_organizations(id) ON DELETE CASCADE,
  date_from date NOT NULL,
  date_to date NOT NULL,
  compare_mode varchar(24) NOT NULL,
  metric varchar(64) NOT NULL,
  live_value numeric(20, 8),
  projected_value numeric(20, 8),
  absolute_difference numeric(20, 8),
  tolerance numeric(20, 8) NOT NULL,
  projection_version integer NOT NULL,
  projection_as_of timestamptz,
  selected_group_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_group_projection_reconciliation_compare_check
    CHECK (compare_mode IN ('none', 'prior_period')),
  CONSTRAINT business_group_projection_reconciliation_tolerance_check
    CHECK (tolerance >= 0),
  CONSTRAINT business_group_projection_reconciliation_difference_check
    CHECK (absolute_difference IS NULL OR absolute_difference >= 0)
);

CREATE INDEX IF NOT EXISTS business_group_projection_reconciliation_org_period_idx
  ON business_group_projection_reconciliation_events(organization_id, date_from, date_to);
CREATE INDEX IF NOT EXISTS business_group_projection_reconciliation_observed_idx
  ON business_group_projection_reconciliation_events(observed_at);

ALTER TABLE business_group_projection_reconciliation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_group_projection_reconciliation_select
  ON business_group_projection_reconciliation_events;
CREATE POLICY business_group_projection_reconciliation_select
ON business_group_projection_reconciliation_events FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM auth_members membership
    WHERE membership.organization_id = business_group_projection_reconciliation_events.organization_id
      AND membership.user_id = current_user_id()
  )
  OR organization_id = current_organization_id()
);

DROP POLICY IF EXISTS business_group_projection_reconciliation_insert
  ON business_group_projection_reconciliation_events;
CREATE POLICY business_group_projection_reconciliation_insert
ON business_group_projection_reconciliation_events FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM auth_members membership
    WHERE membership.organization_id = business_group_projection_reconciliation_events.organization_id
      AND membership.user_id = current_user_id()
  )
  OR organization_id = current_organization_id()
);

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT ON business_group_projection_reconciliation_events TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;
