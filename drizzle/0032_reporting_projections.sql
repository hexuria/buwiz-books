-- Durable, organization-scoped reporting facts for set-based Enterprise
-- portfolio reads. Ledger triggers only mark dirty dates and enqueue work;
-- the application worker performs the accounting aggregation.

CREATE OR REPLACE FUNCTION current_organization_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '');
$$;

CREATE TABLE IF NOT EXISTS organization_reporting_accounts (
  organization_id text NOT NULL REFERENCES auth_organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_name varchar(255) NOT NULL,
  account_number varchar(10),
  account_type varchar(50) NOT NULL,
  subtype varchar(100),
  parent_id uuid,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, account_id)
);
CREATE INDEX IF NOT EXISTS organization_reporting_accounts_org_number_idx
  ON organization_reporting_accounts(organization_id, account_number);

CREATE TABLE IF NOT EXISTS organization_daily_account_activity (
  organization_id text NOT NULL REFERENCES auth_organizations(id) ON DELETE CASCADE,
  activity_date date NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  total_debit numeric(20, 8) NOT NULL DEFAULT 0,
  total_credit numeric(20, 8) NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, activity_date, account_id)
);
CREATE INDEX IF NOT EXISTS organization_daily_account_activity_org_account_date_idx
  ON organization_daily_account_activity(organization_id, account_id, activity_date);

CREATE TABLE IF NOT EXISTS organization_reporting_dirty_dates (
  organization_id text NOT NULL REFERENCES auth_organizations(id) ON DELETE CASCADE,
  activity_date date NOT NULL,
  version integer NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, activity_date),
  CONSTRAINT organization_reporting_dirty_dates_version_check CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS organization_reporting_dirty_dates_marked_idx
  ON organization_reporting_dirty_dates(marked_at);

CREATE TABLE IF NOT EXISTS organization_reporting_projection_state (
  organization_id text PRIMARY KEY REFERENCES auth_organizations(id) ON DELETE CASCADE,
  status varchar(24) NOT NULL DEFAULT 'pending',
  requested_version integer NOT NULL DEFAULT 0,
  applied_version integer NOT NULL DEFAULT 0,
  full_rebuild_requested boolean NOT NULL DEFAULT false,
  last_ledger_event_at timestamptz,
  last_projected_at timestamptz,
  initial_backfill_completed_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_reporting_projection_state_status_check
    CHECK (status IN ('pending', 'building', 'ready', 'failed')),
  CONSTRAINT organization_reporting_projection_state_versions_check
    CHECK (requested_version >= 0 AND applied_version >= 0 AND applied_version <= requested_version)
);
CREATE INDEX IF NOT EXISTS organization_reporting_projection_state_status_idx
  ON organization_reporting_projection_state(status, updated_at);

-- One call represents one distinct organization/date touched by a SQL
-- statement. The job queue's partial unique index coalesces a burst into one
-- active worker job per organization.
CREATE OR REPLACE FUNCTION mark_organization_reporting_dirty(
  target_organization_id text,
  target_activity_date date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  next_version integer;
BEGIN
  IF target_organization_id IS NULL OR target_activity_date IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_group_entities
    WHERE organization_id = target_organization_id AND status = 'enabled'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO organization_reporting_projection_state (
    organization_id,
    status,
    requested_version,
    applied_version,
    last_ledger_event_at,
    updated_at
  )
  VALUES (target_organization_id, 'pending', 1, 0, now(), now())
  ON CONFLICT (organization_id) DO UPDATE
  SET status = 'pending',
      requested_version = organization_reporting_projection_state.requested_version + 1,
      last_ledger_event_at = now(),
      last_error = NULL,
      updated_at = now()
  RETURNING requested_version INTO next_version;

  INSERT INTO organization_reporting_dirty_dates (
    organization_id,
    activity_date,
    version,
    marked_at
  )
  VALUES (target_organization_id, target_activity_date, next_version, now())
  ON CONFLICT (organization_id, activity_date) DO UPDATE
  SET version = EXCLUDED.version,
      marked_at = EXCLUDED.marked_at;

  INSERT INTO processing_jobs (
    organization_id,
    job_type,
    dedupe_key,
    max_attempts,
    payload
  )
  VALUES (
    target_organization_id,
    'business_group_projection_refresh',
    'business_group_projection_refresh',
    8,
    '{}'::jsonb
  )
  ON CONFLICT DO NOTHING;

  PERFORM pg_notify('business_group_projection_dirty', target_organization_id);
END;
$$;

REVOKE ALL ON FUNCTION mark_organization_reporting_dirty(text, date) FROM PUBLIC;

CREATE OR REPLACE FUNCTION request_organization_reporting_full_rebuild(
  target_organization_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF target_organization_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_group_entities
    WHERE organization_id = target_organization_id AND status = 'enabled'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO organization_reporting_projection_state (
    organization_id,
    status,
    requested_version,
    applied_version,
    full_rebuild_requested,
    updated_at
  )
  VALUES (target_organization_id, 'pending', 1, 0, true, now())
  ON CONFLICT (organization_id) DO UPDATE
  SET status = 'pending',
      requested_version = organization_reporting_projection_state.requested_version + 1,
      full_rebuild_requested = true,
      last_error = NULL,
      updated_at = now();

  INSERT INTO processing_jobs (
    organization_id,
    job_type,
    dedupe_key,
    max_attempts,
    payload
  )
  VALUES (
    target_organization_id,
    'business_group_projection_refresh',
    'business_group_projection_refresh',
    8,
    '{}'::jsonb
  )
  ON CONFLICT DO NOTHING;

  PERFORM pg_notify('business_group_projection_dirty', target_organization_id);
END;
$$;

REVOKE ALL ON FUNCTION request_organization_reporting_full_rebuild(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mark_organization_reporting_metadata_dirty(
  target_organization_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF target_organization_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_group_entities
    WHERE organization_id = target_organization_id AND status = 'enabled'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO organization_reporting_projection_state (
    organization_id,
    status,
    requested_version,
    applied_version,
    updated_at
  )
  VALUES (target_organization_id, 'pending', 1, 0, now())
  ON CONFLICT (organization_id) DO UPDATE
  SET status = 'pending',
      requested_version = organization_reporting_projection_state.requested_version + 1,
      last_error = NULL,
      updated_at = now();

  INSERT INTO processing_jobs (
    organization_id,
    job_type,
    dedupe_key,
    max_attempts,
    payload
  )
  VALUES (
    target_organization_id,
    'business_group_projection_refresh',
    'business_group_projection_refresh',
    8,
    '{}'::jsonb
  )
  ON CONFLICT DO NOTHING;

  PERFORM pg_notify('business_group_projection_dirty', target_organization_id);
END;
$$;

REVOKE ALL ON FUNCTION mark_organization_reporting_metadata_dirty(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mark_reporting_from_changed_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_metadata_dirty(organization_id)
  FROM (
    SELECT DISTINCT organization_id FROM old_accounts
    UNION
    SELECT DISTINCT organization_id FROM new_accounts
  ) changed;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mark_reporting_from_inserted_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_metadata_dirty(organization_id)
  FROM (SELECT DISTINCT organization_id FROM new_accounts) changed;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mark_reporting_from_deleted_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_metadata_dirty(organization_id)
  FROM (SELECT DISTINCT organization_id FROM old_accounts) changed;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS accounts_reporting_insert ON accounts;
CREATE TRIGGER accounts_reporting_insert
AFTER INSERT ON accounts
REFERENCING NEW TABLE AS new_accounts
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_inserted_accounts();

DROP TRIGGER IF EXISTS accounts_reporting_update ON accounts;
CREATE TRIGGER accounts_reporting_update
AFTER UPDATE ON accounts
REFERENCING OLD TABLE AS old_accounts NEW TABLE AS new_accounts
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_changed_accounts();

DROP TRIGGER IF EXISTS accounts_reporting_delete ON accounts;
CREATE TRIGGER accounts_reporting_delete
AFTER DELETE ON accounts
REFERENCING OLD TABLE AS old_accounts
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_deleted_accounts();

CREATE OR REPLACE FUNCTION request_reporting_for_inserted_group_entities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM request_organization_reporting_full_rebuild(organization_id)
  FROM (
    SELECT DISTINCT organization_id
    FROM new_group_entities
    WHERE status = 'enabled'
  ) linked;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION request_reporting_for_restored_group_entities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM request_organization_reporting_full_rebuild(organization_id)
  FROM (
    SELECT DISTINCT current_entity.organization_id
    FROM new_group_entities current_entity
    JOIN old_group_entities previous_entity USING (id)
    WHERE current_entity.status = 'enabled'
      AND (
        previous_entity.status IS DISTINCT FROM 'enabled'
        OR previous_entity.organization_id IS DISTINCT FROM current_entity.organization_id
      )
  ) restored;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS organization_group_entities_reporting_insert ON organization_group_entities;
CREATE TRIGGER organization_group_entities_reporting_insert
AFTER INSERT ON organization_group_entities
REFERENCING NEW TABLE AS new_group_entities
FOR EACH STATEMENT EXECUTE FUNCTION request_reporting_for_inserted_group_entities();

DROP TRIGGER IF EXISTS organization_group_entities_reporting_update ON organization_group_entities;
CREATE TRIGGER organization_group_entities_reporting_update
AFTER UPDATE ON organization_group_entities
REFERENCING OLD TABLE AS old_group_entities NEW TABLE AS new_group_entities
FOR EACH STATEMENT EXECUTE FUNCTION request_reporting_for_restored_group_entities();

CREATE OR REPLACE FUNCTION mark_reporting_from_inserted_headers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_dirty(organization_id, transaction_date)
  FROM (
    SELECT DISTINCT organization_id, transaction_date
    FROM new_headers
  ) touched;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mark_reporting_from_updated_headers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_dirty(organization_id, transaction_date)
  FROM (
    SELECT DISTINCT organization_id, transaction_date FROM old_headers
    UNION
    SELECT DISTINCT organization_id, transaction_date FROM new_headers
  ) touched;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mark_reporting_from_deleted_headers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_dirty(organization_id, transaction_date)
  FROM (
    SELECT DISTINCT organization_id, transaction_date
    FROM old_headers
  ) touched;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mark_reporting_from_inserted_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_dirty(organization_id, transaction_date)
  FROM (
    SELECT DISTINCT headers.organization_id, headers.transaction_date
    FROM new_lines lines
    JOIN journal_headers headers ON headers.id = lines.journal_header_id
  ) touched;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mark_reporting_from_updated_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_dirty(organization_id, transaction_date)
  FROM (
    SELECT DISTINCT headers.organization_id, headers.transaction_date
    FROM (
      SELECT journal_header_id FROM old_lines
      UNION
      SELECT journal_header_id FROM new_lines
    ) lines
    JOIN journal_headers headers ON headers.id = lines.journal_header_id
  ) touched;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mark_reporting_from_deleted_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM mark_organization_reporting_dirty(organization_id, transaction_date)
  FROM (
    SELECT DISTINCT headers.organization_id, headers.transaction_date
    FROM old_lines lines
    JOIN journal_headers headers ON headers.id = lines.journal_header_id
  ) touched;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS journal_headers_reporting_insert ON journal_headers;
CREATE TRIGGER journal_headers_reporting_insert
AFTER INSERT ON journal_headers
REFERENCING NEW TABLE AS new_headers
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_inserted_headers();

DROP TRIGGER IF EXISTS journal_headers_reporting_update ON journal_headers;
CREATE TRIGGER journal_headers_reporting_update
AFTER UPDATE ON journal_headers
REFERENCING OLD TABLE AS old_headers NEW TABLE AS new_headers
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_updated_headers();

DROP TRIGGER IF EXISTS journal_headers_reporting_delete ON journal_headers;
CREATE TRIGGER journal_headers_reporting_delete
AFTER DELETE ON journal_headers
REFERENCING OLD TABLE AS old_headers
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_deleted_headers();

DROP TRIGGER IF EXISTS journal_lines_reporting_insert ON journal_lines;
CREATE TRIGGER journal_lines_reporting_insert
AFTER INSERT ON journal_lines
REFERENCING NEW TABLE AS new_lines
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_inserted_lines();

DROP TRIGGER IF EXISTS journal_lines_reporting_update ON journal_lines;
CREATE TRIGGER journal_lines_reporting_update
AFTER UPDATE ON journal_lines
REFERENCING OLD TABLE AS old_lines NEW TABLE AS new_lines
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_updated_lines();

DROP TRIGGER IF EXISTS journal_lines_reporting_delete ON journal_lines;
CREATE TRIGGER journal_lines_reporting_delete
AFTER DELETE ON journal_lines
REFERENCING OLD TABLE AS old_lines
FOR EACH STATEMENT EXECUTE FUNCTION mark_reporting_from_deleted_lines();

ALTER TABLE organization_daily_account_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_reporting_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_reporting_dirty_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_reporting_projection_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_reporting_accounts_select ON organization_reporting_accounts;
CREATE POLICY organization_reporting_accounts_select
ON organization_reporting_accounts FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM auth_members membership
    WHERE membership.organization_id = organization_reporting_accounts.organization_id
      AND membership.user_id = current_user_id()
  )
  OR organization_id = current_organization_id()
);
DROP POLICY IF EXISTS organization_reporting_accounts_worker_write ON organization_reporting_accounts;
CREATE POLICY organization_reporting_accounts_worker_write
ON organization_reporting_accounts FOR ALL
USING (organization_id = current_organization_id())
WITH CHECK (organization_id = current_organization_id());

DROP POLICY IF EXISTS organization_daily_account_activity_select ON organization_daily_account_activity;
CREATE POLICY organization_daily_account_activity_select
ON organization_daily_account_activity FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM auth_members membership
    WHERE membership.organization_id = organization_daily_account_activity.organization_id
      AND membership.user_id = current_user_id()
  )
  OR organization_id = current_organization_id()
);
DROP POLICY IF EXISTS organization_daily_account_activity_worker_write ON organization_daily_account_activity;
CREATE POLICY organization_daily_account_activity_worker_write
ON organization_daily_account_activity FOR ALL
USING (organization_id = current_organization_id())
WITH CHECK (organization_id = current_organization_id());

DROP POLICY IF EXISTS organization_reporting_dirty_dates_select ON organization_reporting_dirty_dates;
CREATE POLICY organization_reporting_dirty_dates_select
ON organization_reporting_dirty_dates FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM auth_members membership
    WHERE membership.organization_id = organization_reporting_dirty_dates.organization_id
      AND membership.user_id = current_user_id()
  )
  OR organization_id = current_organization_id()
);
DROP POLICY IF EXISTS organization_reporting_dirty_dates_worker_write ON organization_reporting_dirty_dates;
CREATE POLICY organization_reporting_dirty_dates_worker_write
ON organization_reporting_dirty_dates FOR ALL
USING (organization_id = current_organization_id())
WITH CHECK (organization_id = current_organization_id());

DROP POLICY IF EXISTS organization_reporting_projection_state_select ON organization_reporting_projection_state;
CREATE POLICY organization_reporting_projection_state_select
ON organization_reporting_projection_state FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM auth_members membership
    WHERE membership.organization_id = organization_reporting_projection_state.organization_id
      AND membership.user_id = current_user_id()
  )
  OR organization_id = current_organization_id()
);
DROP POLICY IF EXISTS organization_reporting_projection_state_worker_write ON organization_reporting_projection_state;
CREATE POLICY organization_reporting_projection_state_worker_write
ON organization_reporting_projection_state FOR ALL
USING (organization_id = current_organization_id())
WITH CHECK (organization_id = current_organization_id());

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON '
        'organization_reporting_accounts, organization_daily_account_activity, organization_reporting_dirty_dates, '
        'organization_reporting_projection_state TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

-- Existing enabled Business Group entities need full history before the read
-- mode can switch. New links request the same backfill in application code.
INSERT INTO organization_reporting_projection_state (
  organization_id,
  status,
  requested_version,
  applied_version,
  full_rebuild_requested,
  updated_at
)
SELECT DISTINCT organization_id, 'pending', 1, 0, true, now()
FROM organization_group_entities
WHERE status = 'enabled'
ON CONFLICT (organization_id) DO UPDATE
SET status = 'pending',
    requested_version = organization_reporting_projection_state.requested_version + 1,
    full_rebuild_requested = true,
    last_error = NULL,
    updated_at = now();

INSERT INTO processing_jobs (
  organization_id,
  job_type,
  dedupe_key,
  max_attempts,
  payload
)
SELECT DISTINCT
  organization_id,
  'business_group_projection_refresh',
  'business_group_projection_refresh',
  8,
  '{}'::jsonb
FROM organization_group_entities
WHERE status = 'enabled'
ON CONFLICT DO NOTHING;
