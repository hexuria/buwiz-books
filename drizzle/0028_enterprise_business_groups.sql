-- Enterprise Business Groups and contract-managed feature entitlement.
-- Additive and non-destructive. Re-running is safe.

CREATE OR REPLACE FUNCTION current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$;

CREATE TABLE IF NOT EXISTS enterprise_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'active',
  billing_contact_email varchar(320),
  external_customer_id varchar(255),
  created_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_accounts_status_check CHECK (status IN ('active', 'suspended'))
);
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_accounts_external_customer_unique
  ON enterprise_accounts(external_customer_id) WHERE external_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS enterprise_account_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_account_id uuid NOT NULL REFERENCES enterprise_accounts(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  role varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_account_members_role_check
    CHECK (role IN ('owner', 'billing_admin', 'group_admin'))
);
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_account_members_account_user_unique
  ON enterprise_account_members(enterprise_account_id, user_id);
CREATE INDEX IF NOT EXISTS enterprise_account_members_user_idx
  ON enterprise_account_members(user_id, enterprise_account_id);

CREATE TABLE IF NOT EXISTS account_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_account_id uuid NOT NULL REFERENCES enterprise_accounts(id) ON DELETE CASCADE,
  feature_key varchar(64) NOT NULL,
  status varchar(24) NOT NULL,
  included_entity_limit integer NOT NULL,
  provisioning_source varchar(32) NOT NULL DEFAULT 'contract',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  grace_ends_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_entitlements_status_check
    CHECK (status IN ('pending', 'active', 'grace', 'locked', 'cancelled')),
  CONSTRAINT account_entitlements_limit_check CHECK (included_entity_limit > 0),
  CONSTRAINT account_entitlements_version_check CHECK (version > 0),
  CONSTRAINT account_entitlements_grace_dates_check
    CHECK (grace_ends_at IS NULL OR ends_at IS NULL OR grace_ends_at >= ends_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_entitlements_account_feature_unique
  ON account_entitlements(enterprise_account_id, feature_key);
CREATE INDEX IF NOT EXISTS account_entitlements_state_idx
  ON account_entitlements(feature_key, status, ends_at);

CREATE TABLE IF NOT EXISTS entitlement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_account_id uuid NOT NULL REFERENCES enterprise_accounts(id) ON DELETE CASCADE,
  entitlement_id uuid NOT NULL REFERENCES account_entitlements(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
  event_type varchar(64) NOT NULL,
  reason text,
  previous_state jsonb,
  next_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entitlement_events_account_created_idx
  ON entitlement_events(enterprise_account_id, created_at);

CREATE TABLE IF NOT EXISTS organization_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_account_id uuid NOT NULL REFERENCES enterprise_accounts(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'active',
  reporting_timezone varchar(64) NOT NULL DEFAULT 'UTC',
  default_reporting_currency varchar(3) NOT NULL DEFAULT 'USD',
  created_by text NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_groups_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT organization_groups_currency_check
    CHECK (default_reporting_currency = upper(default_reporting_currency)
      AND length(default_reporting_currency) = 3)
);
CREATE INDEX IF NOT EXISTS organization_groups_account_idx
  ON organization_groups(enterprise_account_id, status);

CREATE TABLE IF NOT EXISTS organization_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES organization_groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  role varchar(24) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_group_members_role_check
    CHECK (role IN ('owner', 'admin', 'analyst', 'viewer'))
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_group_members_group_user_unique
  ON organization_group_members(group_id, user_id);
CREATE INDEX IF NOT EXISTS organization_group_members_user_idx
  ON organization_group_members(user_id, group_id);

CREATE TABLE IF NOT EXISTS organization_group_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES organization_groups(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES auth_organizations(id) ON DELETE RESTRICT,
  parent_entity_id uuid,
  status varchar(24) NOT NULL DEFAULT 'enabled',
  created_by text NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_group_entities_status_check CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT organization_group_entities_not_own_parent_check
    CHECK (parent_entity_id IS NULL OR parent_entity_id <> id),
  CONSTRAINT organization_group_entities_group_id_id_unique UNIQUE(group_id, id),
  CONSTRAINT organization_group_entities_same_group_parent_fk
    FOREIGN KEY(group_id, parent_entity_id)
    REFERENCES organization_group_entities(group_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_group_entities_group_org_unique
  ON organization_group_entities(group_id, organization_id);
CREATE INDEX IF NOT EXISTS organization_group_entities_group_parent_idx
  ON organization_group_entities(group_id, parent_entity_id);
CREATE INDEX IF NOT EXISTS organization_group_entities_org_idx
  ON organization_group_entities(organization_id);

CREATE TABLE IF NOT EXISTS organization_group_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_account_id uuid NOT NULL REFERENCES enterprise_accounts(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES organization_groups(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
  event_type varchar(64) NOT NULL,
  subject_type varchar(32) NOT NULL,
  subject_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_group_audit_group_created_idx
  ON organization_group_audit_events(group_id, created_at);
CREATE INDEX IF NOT EXISTS organization_group_audit_account_created_idx
  ON organization_group_audit_events(enterprise_account_id, created_at);

-- SECURITY DEFINER helpers prevent recursive RLS policies on membership tables.
-- They only trust the request-scoped current_user_id() set by withUserContext().
CREATE OR REPLACE FUNCTION is_enterprise_account_member(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM enterprise_account_members membership
    WHERE membership.enterprise_account_id = target_account_id
      AND membership.user_id = current_user_id()
  );
$$;

CREATE OR REPLACE FUNCTION can_access_organization_group(target_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_group_members membership
    INNER JOIN organization_groups groups ON groups.id = membership.group_id
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
      AND account_membership.user_id = membership.user_id
    WHERE membership.group_id = target_group_id
      AND membership.user_id = current_user_id()
  );
$$;

CREATE OR REPLACE FUNCTION can_manage_enterprise_account(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM enterprise_account_members membership
    WHERE membership.enterprise_account_id = target_account_id
      AND membership.user_id = current_user_id()
      AND membership.role IN ('owner', 'group_admin')
  );
$$;

CREATE OR REPLACE FUNCTION can_manage_organization_group(target_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_group_members membership
    INNER JOIN organization_groups groups ON groups.id = membership.group_id
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
      AND account_membership.user_id = membership.user_id
    WHERE membership.group_id = target_group_id
      AND membership.user_id = current_user_id()
      AND membership.role IN ('owner', 'admin')
  );
$$;

-- Allows the account owner/group-admin who just created a group to add the
-- first owner membership. Once any membership exists, normal manager rules
-- apply; the creator cannot use this as a back door after being removed.
CREATE OR REPLACE FUNCTION can_bootstrap_organization_group(
  target_group_id uuid,
  target_user_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT target_user_id = current_user_id()
    AND EXISTS (
      SELECT 1
      FROM organization_groups groups
      WHERE groups.id = target_group_id
        AND groups.created_by = current_user_id()
        AND can_manage_enterprise_account(groups.enterprise_account_id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM organization_group_members membership
      WHERE membership.group_id = target_group_id
    );
$$;

ALTER TABLE enterprise_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enterprise_accounts_member_access ON enterprise_accounts;
CREATE POLICY enterprise_accounts_member_access ON enterprise_accounts FOR SELECT
  USING (is_enterprise_account_member(id));

ALTER TABLE enterprise_account_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS enterprise_account_members_member_access ON enterprise_account_members;
CREATE POLICY enterprise_account_members_member_access ON enterprise_account_members FOR SELECT
  USING (is_enterprise_account_member(enterprise_account_id));

ALTER TABLE account_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_entitlements_member_access ON account_entitlements;
CREATE POLICY account_entitlements_member_access ON account_entitlements FOR SELECT
  USING (is_enterprise_account_member(enterprise_account_id));

ALTER TABLE entitlement_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entitlement_events_member_access ON entitlement_events;
CREATE POLICY entitlement_events_member_access ON entitlement_events FOR SELECT
  USING (is_enterprise_account_member(enterprise_account_id));

ALTER TABLE organization_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_groups_member_select ON organization_groups;
CREATE POLICY organization_groups_member_select ON organization_groups FOR SELECT
  USING (
    can_access_organization_group(id)
    OR is_enterprise_account_member(enterprise_account_id)
  );
DROP POLICY IF EXISTS organization_groups_account_insert ON organization_groups;
CREATE POLICY organization_groups_account_insert ON organization_groups FOR INSERT
  WITH CHECK (can_manage_enterprise_account(enterprise_account_id));
DROP POLICY IF EXISTS organization_groups_member_update ON organization_groups;
CREATE POLICY organization_groups_member_update ON organization_groups FOR UPDATE
  USING (can_manage_organization_group(id))
  WITH CHECK (can_manage_organization_group(id));

ALTER TABLE organization_group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_group_members_group_access ON organization_group_members;
DROP POLICY IF EXISTS organization_group_members_group_select ON organization_group_members;
DROP POLICY IF EXISTS organization_group_members_group_insert ON organization_group_members;
DROP POLICY IF EXISTS organization_group_members_group_update ON organization_group_members;
DROP POLICY IF EXISTS organization_group_members_group_delete ON organization_group_members;
CREATE POLICY organization_group_members_group_select ON organization_group_members FOR SELECT
  USING (can_access_organization_group(group_id))
;
CREATE POLICY organization_group_members_group_insert ON organization_group_members FOR INSERT
  WITH CHECK (
    can_manage_organization_group(group_id)
    OR (role = 'owner' AND can_bootstrap_organization_group(group_id, user_id))
  );
CREATE POLICY organization_group_members_group_update ON organization_group_members FOR UPDATE
  USING (can_manage_organization_group(group_id))
  WITH CHECK (can_manage_organization_group(group_id));
CREATE POLICY organization_group_members_group_delete ON organization_group_members FOR DELETE
  USING (can_manage_organization_group(group_id));

ALTER TABLE organization_group_entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_group_entities_group_access ON organization_group_entities;
DROP POLICY IF EXISTS organization_group_entities_group_select ON organization_group_entities;
DROP POLICY IF EXISTS organization_group_entities_group_insert ON organization_group_entities;
DROP POLICY IF EXISTS organization_group_entities_group_update ON organization_group_entities;
DROP POLICY IF EXISTS organization_group_entities_group_delete ON organization_group_entities;
CREATE POLICY organization_group_entities_group_select ON organization_group_entities FOR SELECT
  USING (can_access_organization_group(group_id));
CREATE POLICY organization_group_entities_group_insert ON organization_group_entities FOR INSERT
  WITH CHECK (can_manage_organization_group(group_id));
CREATE POLICY organization_group_entities_group_update ON organization_group_entities FOR UPDATE
  USING (can_manage_organization_group(group_id))
  WITH CHECK (can_manage_organization_group(group_id));
CREATE POLICY organization_group_entities_group_delete ON organization_group_entities FOR DELETE
  USING (can_manage_organization_group(group_id));

ALTER TABLE organization_group_audit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_group_audit_events_group_access ON organization_group_audit_events;
DROP POLICY IF EXISTS organization_group_audit_events_group_select ON organization_group_audit_events;
DROP POLICY IF EXISTS organization_group_audit_events_group_insert ON organization_group_audit_events;
CREATE POLICY organization_group_audit_events_group_select ON organization_group_audit_events FOR SELECT
  USING (can_access_organization_group(group_id));
CREATE POLICY organization_group_audit_events_group_insert ON organization_group_audit_events FOR INSERT
  WITH CHECK (can_manage_organization_group(group_id));

-- Existing runtime roles may predate these tables and therefore miss grants.
DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON '
        'enterprise_accounts, enterprise_account_members, account_entitlements, '
        'entitlement_events, organization_groups, organization_group_members, '
        'organization_group_entities, organization_group_audit_events TO %I',
        runtime_role
      );
      EXECUTE format('GRANT EXECUTE ON FUNCTION is_enterprise_account_member(uuid) TO %I', runtime_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION can_access_organization_group(uuid) TO %I', runtime_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION can_manage_enterprise_account(uuid) TO %I', runtime_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION can_manage_organization_group(uuid) TO %I', runtime_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION can_bootstrap_organization_group(uuid, text) TO %I', runtime_role);
    END IF;
  END LOOP;
END $$;
