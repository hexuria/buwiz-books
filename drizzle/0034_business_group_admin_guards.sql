-- Compose Enterprise-account and Business-Group roles for every group mutation,
-- and make lifecycle, audit, membership, and eligible-owner invariants survive
-- direct runtime writes, RLS bypass, and races.

-- The migration runner executes this file transactionally. Block legacy DML
-- in a stable table order before validating existing rows so no write can
-- invalidate a preflight before the corresponding guard is installed.
LOCK TABLE account_entitlements IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE auth_users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE enterprise_accounts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE enterprise_account_members IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE organization_groups IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE organization_group_members IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE organization_group_entities IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  orphaned_groups text;
BEGIN
  SELECT string_agg(candidate.id::text, ', ' ORDER BY candidate.id)
  INTO orphaned_groups
  FROM (
    SELECT groups.id
    FROM organization_groups groups
    WHERE NOT EXISTS (
      SELECT 1
      FROM organization_group_members group_membership
      INNER JOIN enterprise_account_members account_membership
        ON account_membership.enterprise_account_id = groups.enterprise_account_id
       AND account_membership.user_id = group_membership.user_id
       AND account_membership.role IN ('owner', 'group_admin')
      WHERE group_membership.group_id = groups.id
        AND group_membership.role = 'owner'
    )
    ORDER BY groups.id
    LIMIT 20
  ) candidate;

  IF orphaned_groups IS NOT NULL THEN
    RAISE EXCEPTION
      'Business Group admin-guard migration blocked: groups without an eligible owner: %',
      orphaned_groups
      USING HINT = 'Grant at least one group owner an Enterprise owner or group_admin role before retrying.';
  END IF;
END
$preflight$;

DO $preflight$
DECLARE
  invalid_memberships text;
BEGIN
  SELECT string_agg(
    candidate.group_id::text || ':' || candidate.user_id,
    ', ' ORDER BY candidate.group_id, candidate.user_id
  )
  INTO invalid_memberships
  FROM (
    SELECT group_membership.group_id, group_membership.user_id
    FROM organization_group_members group_membership
    INNER JOIN organization_groups groups
      ON groups.id = group_membership.group_id
    LEFT JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
     AND account_membership.user_id = group_membership.user_id
    WHERE account_membership.id IS NULL
    ORDER BY group_membership.group_id, group_membership.user_id
    LIMIT 20
  ) candidate;

  IF invalid_memberships IS NOT NULL THEN
    RAISE EXCEPTION
      'Business Group admin-guard migration blocked: group memberships without matching Enterprise membership: %',
      invalid_memberships
      USING HINT = 'Add each user to the group Enterprise account or remove the Business Group membership before retrying.';
  END IF;
END
$preflight$;

DO $preflight$
DECLARE
  ineligible_owner_memberships text;
BEGIN
  SELECT string_agg(
    candidate.group_id::text || ':' || candidate.user_id,
    ', ' ORDER BY candidate.group_id, candidate.user_id
  )
  INTO ineligible_owner_memberships
  FROM (
    SELECT group_membership.group_id, group_membership.user_id
    FROM organization_group_members group_membership
    INNER JOIN organization_groups groups
      ON groups.id = group_membership.group_id
    WHERE group_membership.role = 'owner'
      AND NOT EXISTS (
        SELECT 1
        FROM enterprise_account_members account_membership
        WHERE account_membership.enterprise_account_id = groups.enterprise_account_id
          AND account_membership.user_id = group_membership.user_id
          AND account_membership.role IN ('owner', 'group_admin')
      )
    ORDER BY group_membership.group_id, group_membership.user_id
    LIMIT 20
  ) candidate;

  IF ineligible_owner_memberships IS NOT NULL THEN
    RAISE EXCEPTION
      'Business Group admin-guard migration blocked: ineligible group-owner memberships: %',
      ineligible_owner_memberships
      USING HINT = 'Grant each listed user an Enterprise owner or group_admin role, or demote/remove the Business Group owner membership before retrying.';
  END IF;
END
$preflight$;

DO $preflight$
DECLARE
  archived_enabled_entities text;
BEGIN
  SELECT string_agg(
    candidate.group_id::text || ':' || candidate.entity_id::text,
    ', ' ORDER BY candidate.group_id, candidate.entity_id
  )
  INTO archived_enabled_entities
  FROM (
    SELECT groups.id AS group_id, entity.id AS entity_id
    FROM organization_groups groups
    INNER JOIN organization_group_entities entity
      ON entity.group_id = groups.id
     AND entity.status = 'enabled'
    WHERE groups.status = 'archived'
    ORDER BY groups.id, entity.id
    LIMIT 20
  ) candidate;

  IF archived_enabled_entities IS NOT NULL THEN
    RAISE EXCEPTION
      'Business Group admin-guard migration blocked: archived groups with enabled entities: %',
      archived_enabled_entities
      USING HINT = 'Disable each listed assignment or restore its Business Group before retrying.';
  END IF;
END
$preflight$;

DO $preflight$
DECLARE
  invalid_groups text;
BEGIN
  SELECT string_agg(candidate.id::text, ', ' ORDER BY candidate.id)
  INTO invalid_groups
  FROM (
    SELECT groups.id
    FROM organization_groups groups
    WHERE groups.name <> btrim(groups.name)
       OR char_length(groups.name) NOT BETWEEN 2 AND 255
    ORDER BY groups.id
    LIMIT 20
  ) candidate;

  IF invalid_groups IS NOT NULL THEN
    RAISE EXCEPTION
      'Business Group admin-guard migration blocked: groups with invalid untrimmed or out-of-range names: %',
      invalid_groups
      USING HINT = 'Trim each group name and keep it between 2 and 255 characters before retrying.';
  END IF;
END
$preflight$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_groups_name_check'
      AND conrelid = 'organization_groups'::regclass
  ) THEN
    ALTER TABLE organization_groups
      ADD CONSTRAINT organization_groups_name_check
      CHECK (name = btrim(name) AND char_length(name) BETWEEN 2 AND 255);
  END IF;
END
$$;

-- This table is an internal, transaction-scoped capability used only by the
-- SECURITY DEFINER ownership-transfer function below. It deliberately has no
-- foreign keys: the capability is inserted and removed in one transaction,
-- while avoiding new parent/child lock edges in the lifecycle triggers.
CREATE TABLE IF NOT EXISTS business_group_owner_transfer_context (
  transaction_id bigint NOT NULL,
  group_id uuid NOT NULL,
  actor_user_id text NOT NULL,
  previous_owner_user_id text NOT NULL,
  replacement_owner_user_id text NOT NULL,
  PRIMARY KEY (transaction_id, group_id)
);

REVOKE ALL ON TABLE business_group_owner_transfer_context FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', runtime_role);
      EXECUTE format(
        'REVOKE ALL ON TABLE business_group_owner_transfer_context FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$$;

-- Harden SECURITY DEFINER helpers installed by the earlier Enterprise
-- migrations. Listing pg_temp last prevents a caller-created temporary table
-- from shadowing an authorization relation.
ALTER FUNCTION is_enterprise_account_member(uuid)
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION can_access_organization_group(uuid)
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION can_manage_enterprise_account(uuid)
  SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION is_organization_assigned_to_business_group(uuid, text, uuid, text)
  SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION lock_business_group_user_rows(target_user_ids text[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  locked_user_id text;
  locked_count integer := 0;
BEGIN
  FOR locked_user_id IN
    SELECT target_user.id
    FROM auth_users target_user
    INNER JOIN (
      SELECT DISTINCT candidate.user_id
      FROM unnest(target_user_ids) candidate(user_id)
      WHERE candidate.user_id IS NOT NULL
    ) candidate ON candidate.user_id = target_user.id
    ORDER BY target_user.id
    FOR UPDATE OF target_user
  LOOP
    locked_count := locked_count + 1;
  END LOOP;
  RETURN locked_count;
END;
$$;

CREATE OR REPLACE FUNCTION is_enterprise_organization_group_member(
  target_group_id uuid,
  target_user_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_groups groups
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
     AND account_membership.user_id = target_user_id
    WHERE groups.id = target_group_id
  );
$$;

CREATE OR REPLACE FUNCTION has_active_business_groups_entitlement(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_entitlements entitlement
    WHERE entitlement.enterprise_account_id = target_account_id
      AND entitlement.feature_key = 'business_groups'
      AND entitlement.status IN ('pending', 'active')
      AND entitlement.starts_at <= statement_timestamp()
      AND (entitlement.ends_at IS NULL OR entitlement.ends_at > statement_timestamp())
  );
$$;

CREATE OR REPLACE FUNCTION is_eligible_organization_group_owner(
  target_group_id uuid,
  target_user_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_groups groups
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
     AND account_membership.user_id = target_user_id
     AND account_membership.role IN ('owner', 'group_admin')
    WHERE groups.id = target_group_id
  );
$$;

CREATE OR REPLACE FUNCTION can_manage_organization_group(target_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_group_members group_membership
    INNER JOIN organization_groups groups
      ON groups.id = group_membership.group_id
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
     AND account_membership.user_id = group_membership.user_id
     AND account_membership.role IN ('owner', 'group_admin')
    WHERE group_membership.group_id = target_group_id
      AND group_membership.user_id = current_user_id()
      AND group_membership.role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION can_manage_organization_group_owners(target_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_group_members group_membership
    INNER JOIN organization_groups groups
      ON groups.id = group_membership.group_id
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
     AND account_membership.user_id = group_membership.user_id
     AND account_membership.role IN ('owner', 'group_admin')
    WHERE group_membership.group_id = target_group_id
      AND group_membership.user_id = current_user_id()
      AND group_membership.role = 'owner'
  );
$$;

CREATE OR REPLACE FUNCTION can_bootstrap_organization_group(
  target_group_id uuid,
  target_user_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT target_user_id = current_user_id()
    AND is_eligible_organization_group_owner(target_group_id, target_user_id)
    AND EXISTS (
      SELECT 1
      FROM organization_groups groups
      WHERE groups.id = target_group_id
        AND groups.created_by = current_user_id()
        AND can_manage_enterprise_account(groups.enterprise_account_id)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM organization_group_members membership
      WHERE membership.group_id = target_group_id
    );
$$;

CREATE OR REPLACE FUNCTION audit_organization_group_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO organization_group_audit_events (
    enterprise_account_id,
    group_id,
    actor_user_id,
    event_type,
    subject_type,
    subject_id,
    details,
    created_at
  ) VALUES (
    NEW.enterprise_account_id,
    NEW.id,
    current_user_id(),
    'group.created',
    'group',
    NEW.id::text,
    jsonb_build_object(
      'name', NEW.name,
      'reportingTimezone', NEW.reporting_timezone,
      'defaultReportingCurrency', NEW.default_reporting_currency
    ),
    clock_timestamp()
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_organization_group_creation_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  creator_enterprise_role text;
BEGIN
  -- A new group has no child row yet, so explicitly follow every FK parent:
  -- user identity -> Enterprise account -> Enterprise membership -> account
  -- allowance. Parent deletion and role revocation use the same prefix.
  PERFORM lock_business_group_user_rows(
    ARRAY[NEW.created_by, current_user_id()]
  );
  IF NOT EXISTS (SELECT 1 FROM auth_users target_user WHERE target_user.id = NEW.created_by) THEN
    RAISE EXCEPTION 'A Business Group creator must be an existing user';
  END IF;

  PERFORM 1
  FROM enterprise_accounts account
  WHERE account.id = NEW.enterprise_account_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A Business Group requires an existing Enterprise account';
  END IF;

  SELECT account_membership.role
  INTO creator_enterprise_role
  FROM enterprise_account_members account_membership
  WHERE account_membership.enterprise_account_id = NEW.enterprise_account_id
    AND account_membership.user_id = NEW.created_by
  FOR UPDATE;

  IF creator_enterprise_role IS NULL
     OR creator_enterprise_role NOT IN ('owner', 'group_admin')
  THEN
    RAISE EXCEPTION
      'A Business Group creator must be an Enterprise owner or group_admin';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('business-groups:' || NEW.enterprise_account_id::text, 0)
  );

  IF NOT has_active_business_groups_entitlement(NEW.enterprise_account_id) THEN
    RAISE EXCEPTION
      'Business Group configuration changes require an active Enterprise entitlement';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_groups_creation_entitlement_guard ON organization_groups;
CREATE TRIGGER organization_groups_creation_entitlement_guard
BEFORE INSERT ON organization_groups
FOR EACH ROW EXECUTE FUNCTION enforce_organization_group_creation_entitlement();

DROP TRIGGER IF EXISTS organization_groups_creation_audit ON organization_groups;
CREATE TRIGGER organization_groups_creation_audit
AFTER INSERT ON organization_groups
FOR EACH ROW EXECUTE FUNCTION audit_organization_group_creation();

CREATE OR REPLACE FUNCTION enforce_organization_group_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  disabled_entity_count integer := 0;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.enterprise_account_id IS DISTINCT FROM OLD.enterprise_account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Business Group id, enterprise_account_id, created_by, and created_at are immutable';
  END IF;

  IF NEW.name <> btrim(NEW.name)
     OR char_length(NEW.name) NOT BETWEEN 2 AND 255
  THEN
    RAISE EXCEPTION 'A Business Group name must be trimmed and contain 2 to 255 characters';
  END IF;

  IF NEW.reporting_timezone IS DISTINCT FROM OLD.reporting_timezone
     OR NEW.default_reporting_currency IS DISTINCT FROM OLD.default_reporting_currency
  THEN
    RAISE EXCEPTION
      'Business Group reporting_timezone and default_reporting_currency are immutable after creation';
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name
     AND NEW.status IS DISTINCT FROM OLD.status
  THEN
    RAISE EXCEPTION 'Rename and lifecycle status changes must be separate Business Group updates';
  END IF;

  IF OLD.status = 'archived'
     AND NEW.name IS DISTINCT FROM OLD.name
  THEN
    RAISE EXCEPTION 'An archived Business Group is read-only until it is restored';
  END IF;

  -- Every existing-group mutation takes the account allowance namespace
  -- before any group namespace. This also serializes opposite group orderings
  -- inside the same Enterprise account without a group/account lock cycle.
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.status IS DISTINCT FROM OLD.status
  THEN
    IF NOT pg_try_advisory_xact_lock(
      hashtextextended('business-groups:' || OLD.enterprise_account_id::text, 0)
    ) THEN
      -- UPDATE already owns the group row. Never wait on the account namespace
      -- while a concurrent child/parent mutation may be waiting on this row.
      RAISE EXCEPTION
        'Business Group lifecycle serialization conflict; retry the entire transaction'
        USING ERRCODE = '40001',
              HINT = 'Retry the complete Business Group mutation in a new transaction.';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('business-group-assignments:' || OLD.id::text, 0)
    );
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.status IS DISTINCT FROM OLD.status
  THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('business-group-members:' || OLD.id::text, 0)
    );

    IF current_user_id() IS NOT NULL
       AND NOT can_manage_organization_group(OLD.id)
    THEN
      RAISE EXCEPTION
        'The current actor no longer has composed Business Group manager access';
    END IF;
  END IF;

  IF (
       NEW.name IS DISTINCT FROM OLD.name
       OR NEW.status IS DISTINCT FROM OLD.status
     )
     AND NOT has_active_business_groups_entitlement(OLD.enterprise_account_id)
  THEN
    RAISE EXCEPTION
      'Business Group configuration changes require an active Enterprise entitlement';
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name THEN
    INSERT INTO organization_group_audit_events (
      enterprise_account_id,
      group_id,
      actor_user_id,
      event_type,
      subject_type,
      subject_id,
      details,
      created_at
    ) VALUES (
      OLD.enterprise_account_id,
      OLD.id,
      current_user_id(),
      'group.renamed',
      'group',
      OLD.id::text,
      jsonb_build_object('previousName', OLD.name, 'name', NEW.name),
      clock_timestamp()
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'archived' THEN
      UPDATE organization_group_entities
      SET status = 'disabled', updated_at = clock_timestamp()
      WHERE group_id = OLD.id
        AND status = 'enabled';
      GET DIAGNOSTICS disabled_entity_count = ROW_COUNT;

      INSERT INTO organization_group_audit_events (
        enterprise_account_id,
        group_id,
        actor_user_id,
        event_type,
        subject_type,
        subject_id,
        details,
        created_at
      ) VALUES (
        OLD.enterprise_account_id,
        OLD.id,
        current_user_id(),
        'group.archived',
        'group',
        OLD.id::text,
        jsonb_build_object('disabledEntityCount', disabled_entity_count),
        clock_timestamp()
      );
    ELSIF NEW.status = 'active' THEN
      INSERT INTO organization_group_audit_events (
        enterprise_account_id,
        group_id,
        actor_user_id,
        event_type,
        subject_type,
        subject_id,
        details,
        created_at
      ) VALUES (
        OLD.enterprise_account_id,
        OLD.id,
        current_user_id(),
        'group.restored',
        'group',
        OLD.id::text,
        jsonb_build_object('restoredEntityCount', 0),
        clock_timestamp()
      );
    END IF;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.updated_at := clock_timestamp();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_groups_lifecycle_guard ON organization_groups;
CREATE TRIGGER organization_groups_lifecycle_guard
BEFORE UPDATE ON organization_groups
FOR EACH ROW EXECUTE FUNCTION enforce_organization_group_lifecycle();

CREATE OR REPLACE FUNCTION ensure_organization_group_has_eligible_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organization_groups groups WHERE groups.id = NEW.id)
     AND NOT EXISTS (
       SELECT 1
       FROM organization_group_members group_membership
       INNER JOIN organization_groups groups
         ON groups.id = group_membership.group_id
       INNER JOIN enterprise_account_members account_membership
         ON account_membership.enterprise_account_id = groups.enterprise_account_id
        AND account_membership.user_id = group_membership.user_id
        AND account_membership.role IN ('owner', 'group_admin')
       WHERE group_membership.group_id = NEW.id
         AND group_membership.role = 'owner'
     )
  THEN
    RAISE EXCEPTION 'A Business Group must have at least one eligible owner at commit';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS organization_groups_eligible_owner_constraint ON organization_groups;
CREATE CONSTRAINT TRIGGER organization_groups_eligible_owner_constraint
AFTER INSERT ON organization_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_organization_group_has_eligible_owner();

CREATE OR REPLACE FUNCTION enforce_active_organization_group_entity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  locked_group_id uuid;
  locked_account_id uuid;
  touches_archived_group boolean;
  is_access_reduction boolean := false;
  entitlement_limit integer;
  current_usage integer;
  actor_has_organization_admin boolean := false;
  locked_organization_membership record;
BEGIN
  -- Parent group/account cascades deliberately remove the whole assignment
  -- partition and must not be mistaken for an archived-group configuration write.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Business Group assignments must be disabled instead of deleted';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.enterprise_account_id IS DISTINCT FROM OLD.enterprise_account_id
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     )
  THEN
    RAISE EXCEPTION
      'Business Group assignment id, enterprise_account_id, group_id, organization_id, created_by, and created_at are immutable';
  END IF;

  is_access_reduction :=
    TG_OP = 'UPDATE' AND OLD.status = 'enabled' AND NEW.status = 'disabled';

  IF TG_OP = 'INSERT' AND NEW.status <> 'enabled' THEN
    RAISE EXCEPTION 'A new Business Group assignment must be enabled';
  END IF;

  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status)
  THEN
    IF TG_OP = 'INSERT' THEN
      -- The new child does not own any row yet. Pin auth identities, its direct
      -- organization parent and membership rows, the common Enterprise-account
      -- parent, and then the group parent so deletion or role revocation cannot
      -- form an inverse parent order.
      PERFORM lock_business_group_user_rows(
        ARRAY[current_user_id(), NEW.created_by]
      );
      IF NOT EXISTS (SELECT 1 FROM auth_users target_user WHERE target_user.id = NEW.created_by)
      THEN
        RAISE EXCEPTION 'A Business Group assignment creator must be an existing user';
      END IF;

      -- The assignment also has an organization parent. Pin it before every
      -- matching direct-membership row so organization deletion follows the
      -- same organization -> membership -> assignment order. Lock all matches
      -- because the auth schema does not enforce one row per user/org pair.
      PERFORM 1
      FROM auth_organizations target_organization
      WHERE target_organization.id = NEW.organization_id
      FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A Business Group assignment requires an existing organization';
      END IF;

      IF current_user_id() IS NOT NULL THEN
        FOR locked_organization_membership IN
          SELECT membership.id, membership.role
          FROM auth_members membership
          WHERE membership.organization_id = NEW.organization_id
            AND membership.user_id = current_user_id()
          ORDER BY membership.id
          FOR UPDATE OF membership
        LOOP
          actor_has_organization_admin :=
            actor_has_organization_admin
            OR locked_organization_membership.role IN ('owner', 'admin');
        END LOOP;
      END IF;

      SELECT groups.enterprise_account_id
      INTO locked_account_id
      FROM organization_groups groups
      WHERE groups.id = NEW.group_id;
      IF locked_account_id IS NULL THEN
        RAISE EXCEPTION
          'A Business Group assignment requires a matching Enterprise account and group';
      END IF;

      PERFORM 1
      FROM enterprise_accounts account
      WHERE account.id = locked_account_id
      FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A Business Group assignment requires an existing Enterprise account';
      END IF;

      PERFORM 1
      FROM organization_groups groups
      WHERE groups.id = NEW.group_id
        AND groups.enterprise_account_id = locked_account_id
      FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'A Business Group assignment requires a stable Enterprise account and group';
      END IF;
    ELSE
      -- UPDATE already owns the child row. A locking parent read here would
      -- invert the group-delete cascade's group -> child row order.
      SELECT groups.enterprise_account_id
      INTO locked_account_id
      FROM organization_groups groups
      WHERE groups.id = NEW.group_id;
    END IF;

    IF locked_account_id IS NULL
       OR locked_account_id IS DISTINCT FROM NEW.enterprise_account_id
    THEN
      RAISE EXCEPTION
        'A Business Group assignment requires a matching Enterprise account and group';
    END IF;

    IF TG_OP = 'INSERT' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('business-groups:' || NEW.enterprise_account_id::text, 0)
      );
    ELSIF NOT pg_try_advisory_xact_lock(
      hashtextextended('business-groups:' || NEW.enterprise_account_id::text, 0)
    ) THEN
      -- An existing entity UPDATE already owns its child row. Never wait here:
      -- archive owns the account namespace before updating the same child.
      RAISE EXCEPTION
        'Business Group assignment serialization conflict; retry the entire transaction'
        USING ERRCODE = '40001',
              HINT = 'Retry the complete assignment mutation in a new transaction.';
    END IF;

    FOR locked_group_id IN
      SELECT DISTINCT candidate.group_id
      FROM unnest(
        CASE
          WHEN TG_OP = 'UPDATE' THEN ARRAY[OLD.group_id, NEW.group_id]
          ELSE ARRAY[NEW.group_id]
        END
      ) candidate(group_id)
      ORDER BY candidate.group_id
    LOOP
      PERFORM pg_advisory_xact_lock(
        hashtextextended('business-group-assignments:' || locked_group_id::text, 0)
      );
      PERFORM pg_advisory_xact_lock(
        hashtextextended('business-group-members:' || locked_group_id::text, 0)
      );
    END LOOP;

    IF current_user_id() IS NOT NULL
       AND NOT can_manage_organization_group(NEW.group_id)
    THEN
      RAISE EXCEPTION
        'The current actor no longer has composed Business Group manager access';
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.status <> 'enabled'
       AND NEW.status = 'enabled'
       AND current_user_id() IS NOT NULL
    THEN
      -- UPDATE already owns the assignment child. Never wait on an auth
      -- membership that an organization/user cascade may own while waiting on
      -- this entity row; fail fast and retry the complete transaction.
      BEGIN
        FOR locked_organization_membership IN
          SELECT membership.id, membership.role
          FROM auth_members membership
          WHERE membership.organization_id = NEW.organization_id
            AND membership.user_id = current_user_id()
          ORDER BY membership.id
          FOR UPDATE OF membership NOWAIT
        LOOP
          actor_has_organization_admin :=
            actor_has_organization_admin
            OR locked_organization_membership.role IN ('owner', 'admin');
        END LOOP;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION
          'Organization membership serialization conflict; retry the entire transaction'
          USING ERRCODE = '40001',
                HINT = 'Retry the complete assignment restore in a new transaction.';
      END;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      SELECT 1
      FROM organization_groups groups
      WHERE groups.id IN (OLD.group_id, NEW.group_id)
        AND groups.status = 'archived'
    ) INTO touches_archived_group;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM organization_groups groups
      WHERE groups.id = NEW.group_id
        AND groups.status = 'archived'
    ) INTO touches_archived_group;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.status = 'enabled'
     AND NOT EXISTS (
       SELECT 1
       FROM organization_groups groups
       WHERE groups.id = NEW.group_id
         AND groups.enterprise_account_id = NEW.enterprise_account_id
         AND groups.status = 'active'
     )
  THEN
    RAISE EXCEPTION 'An archived Business Group cannot have enabled assignments';
  END IF;
  IF touches_archived_group AND NOT is_access_reduction THEN
    RAISE EXCEPTION
      'An archived Business Group permits only assignment access reduction until it is restored';
  END IF;

  IF TG_OP = 'INSERT'
     AND current_user_id() IS NOT NULL
     AND NEW.created_by IS DISTINCT FROM current_user_id()
  THEN
    RAISE EXCEPTION 'Business Group assignment created_by must match the current actor';
  END IF;

  IF (
       TG_OP = 'INSERT'
       OR (TG_OP = 'UPDATE' AND OLD.status <> 'enabled' AND NEW.status = 'enabled')
     )
     AND current_user_id() IS NOT NULL
     AND NOT actor_has_organization_admin
  THEN
    RAISE EXCEPTION
      'The current actor must be an owner or admin of the assigned organization';
  END IF;

  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND OLD.status <> 'enabled' AND NEW.status = 'enabled')
  THEN
    IF NOT has_active_business_groups_entitlement(NEW.enterprise_account_id) THEN
      RAISE EXCEPTION
        'Business Group assignment changes require an active Enterprise entitlement';
    END IF;

    SELECT entitlement.included_entity_limit
    INTO entitlement_limit
    FROM account_entitlements entitlement
    WHERE entitlement.enterprise_account_id = NEW.enterprise_account_id
      AND entitlement.feature_key = 'business_groups'
    LIMIT 1;

    SELECT count(DISTINCT entity.organization_id)::integer
    INTO current_usage
    FROM organization_group_entities entity
    INNER JOIN organization_groups groups ON groups.id = entity.group_id
    WHERE groups.enterprise_account_id = NEW.enterprise_account_id
      AND groups.status = 'active'
      AND entity.status = 'enabled';

    IF current_usage >= entitlement_limit THEN
      RAISE EXCEPTION
        'The Enterprise linked-entity allowance is %; current usage is %',
        entitlement_limit,
        current_usage;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.updated_at := clock_timestamp();
    ELSE
      NEW.updated_at := OLD.updated_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_group_entities_active_group_guard
  ON organization_group_entities;
CREATE TRIGGER organization_group_entities_active_group_guard
BEFORE INSERT OR UPDATE OR DELETE ON organization_group_entities
FOR EACH ROW EXECUTE FUNCTION enforce_active_organization_group_entity();

CREATE OR REPLACE FUNCTION audit_organization_group_entity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_entity_id uuid;
  target_account_id uuid;
  target_group_id uuid;
  target_organization_id text;
  enabled_usage integer;
BEGIN
  -- Archive performs one nested enabled-to-disabled update and records the
  -- aggregate count on group.archived. Parent cascades remove the audit
  -- partition. Neither case should emit misleading per-entity unlink events.
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  target_entity_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  target_account_id :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.enterprise_account_id ELSE NEW.enterprise_account_id END;
  target_group_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  target_organization_id :=
    CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;

  IF TG_OP = 'DELETE'
     AND (
       NOT EXISTS (
         SELECT 1 FROM enterprise_accounts account WHERE account.id = target_account_id
       )
       OR NOT EXISTS (
         SELECT 1 FROM organization_groups groups WHERE groups.id = target_group_id
       )
     )
  THEN
    RETURN OLD;
  END IF;

  SELECT count(DISTINCT entity.organization_id)::integer
  INTO enabled_usage
  FROM organization_group_entities entity
  INNER JOIN organization_groups groups ON groups.id = entity.group_id
  WHERE groups.enterprise_account_id = target_account_id
    AND groups.status = 'active'
    AND entity.status = 'enabled';

  INSERT INTO organization_group_audit_events (
    enterprise_account_id,
    group_id,
    actor_user_id,
    event_type,
    subject_type,
    subject_id,
    details,
    created_at
  ) VALUES (
    target_account_id,
    target_group_id,
    current_user_id(),
    CASE
      WHEN TG_OP = 'INSERT' THEN 'entity.linked'
      WHEN TG_OP = 'UPDATE' AND NEW.status = 'enabled' THEN 'entity.restored'
      ELSE 'entity.unlinked'
    END,
    'organization',
    target_organization_id,
    jsonb_build_object('entityId', target_entity_id, 'usage', enabled_usage),
    clock_timestamp()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_group_entities_audit ON organization_group_entities;
CREATE TRIGGER organization_group_entities_audit
AFTER INSERT OR UPDATE OR DELETE ON organization_group_entities
FOR EACH ROW EXECUTE FUNCTION audit_organization_group_entity_change();

CREATE OR REPLACE FUNCTION enforce_organization_group_member_invariants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  locked_group_id uuid;
  target_account_id uuid;
  target_enterprise_role text;
  old_role_rank integer := 0;
  new_role_rank integer := 0;
  is_access_reduction boolean := false;
  is_access_increase boolean := false;
  is_owner_transfer boolean := false;
  is_previous_owner_transfer_step boolean := false;
BEGIN
  -- Parent deletion cascades are protected by their parent-row guard (users),
  -- or intentionally remove the whole Enterprise account and all its groups.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     )
  THEN
    RAISE EXCEPTION
      'Business Group membership id, group_id, user_id, and created_at are immutable';
  END IF;

  locked_group_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  IF TG_OP = 'INSERT' THEN
    -- The new child has no row lock yet: auth identities -> Enterprise account
    -- parent -> group parent -> Enterprise membership -> account/member
    -- advisory namespaces.
    PERFORM lock_business_group_user_rows(
      ARRAY[current_user_id(), NEW.user_id]
    );
    IF NOT EXISTS (SELECT 1 FROM auth_users target_user WHERE target_user.id = NEW.user_id) THEN
      RAISE EXCEPTION 'A Business Group member must be an existing user';
    END IF;

    SELECT groups.enterprise_account_id
    INTO target_account_id
    FROM organization_groups groups
    WHERE groups.id = locked_group_id;
    IF target_account_id IS NULL THEN
      RAISE EXCEPTION 'Business Group membership requires an existing Business Group';
    END IF;

    PERFORM 1
    FROM enterprise_accounts account
    WHERE account.id = target_account_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Business Group membership requires an existing Enterprise account';
    END IF;

    PERFORM 1
    FROM organization_groups groups
    WHERE groups.id = locked_group_id
      AND groups.enterprise_account_id = target_account_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Business Group membership requires a stable Business Group parent';
    END IF;
  ELSE
    -- UPDATE/DELETE already owns the membership child. Do not lock its group
    -- parent in the inverse of a group-delete cascade.
    SELECT groups.enterprise_account_id
    INTO target_account_id
    FROM organization_groups groups
    WHERE groups.id = locked_group_id;
  END IF;

  IF target_account_id IS NULL THEN
    RAISE EXCEPTION 'Business Group membership requires an existing Business Group';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_role_rank := CASE OLD.role
      WHEN 'owner' THEN 4
      WHEN 'admin' THEN 3
      WHEN 'analyst' THEN 2
      WHEN 'viewer' THEN 1
      ELSE 0
    END;
    new_role_rank := CASE NEW.role
      WHEN 'owner' THEN 4
      WHEN 'admin' THEN 3
      WHEN 'analyst' THEN 2
      WHEN 'viewer' THEN 1
      ELSE 0
    END;
  END IF;
  is_access_reduction := TG_OP = 'DELETE' OR (
    TG_OP = 'UPDATE' AND new_role_rank < old_role_rank
  );
  is_access_increase := TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE' AND new_role_rank > old_role_rank
  );

  IF TG_OP = 'UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;

  -- INSERT pins the matching Enterprise membership before account -> member
  -- advisory locks. Existing child UPDATE/DELETE never takes an auth or group
  -- parent row, preserving PostgreSQL's parent -> child FK lock order.
  IF TG_OP = 'INSERT' THEN
    SELECT account_membership.role
    INTO target_enterprise_role
    FROM enterprise_account_members account_membership
    WHERE account_membership.enterprise_account_id = target_account_id
      AND account_membership.user_id = NEW.user_id
    FOR UPDATE;
    IF target_enterprise_role IS NULL THEN
      RAISE EXCEPTION
        'A Business Group member must belong to the matching Enterprise account';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('business-groups:' || target_account_id::text, 0)
    );
  ELSIF NOT pg_try_advisory_xact_lock(
    hashtextextended('business-groups:' || target_account_id::text, 0)
  ) THEN
    -- UPDATE/DELETE already owns the membership row. Enterprise/auth parent
    -- guards own their row before this account namespace, so waiting here can
    -- deadlock. Return a retryable serialization failure instead.
    RAISE EXCEPTION
      'Business Group membership serialization conflict; retry the entire transaction'
      USING ERRCODE = '40001',
            HINT = 'Retry the complete membership mutation in a new transaction.';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('business-group-members:' || locked_group_id::text, 0)
  );

  IF TG_OP = 'UPDATE' AND is_access_increase THEN
    SELECT account_membership.role
    INTO target_enterprise_role
    FROM enterprise_account_members account_membership
    WHERE account_membership.enterprise_account_id = target_account_id
      AND account_membership.user_id = NEW.user_id;
    IF target_enterprise_role IS NULL THEN
      RAISE EXCEPTION
        'A Business Group member must belong to the matching Enterprise account';
    END IF;
  END IF;

  IF is_access_increase
     AND NEW.role = 'owner'
     AND target_enterprise_role NOT IN ('owner', 'group_admin')
  THEN
    RAISE EXCEPTION
      'A Business Group owner must be an Enterprise owner or group_admin';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM business_group_owner_transfer_context transfer_context
      WHERE transfer_context.transaction_id = txid_current()
        AND transfer_context.group_id = locked_group_id
        AND transfer_context.actor_user_id = current_user_id()
        AND NEW.user_id = transfer_context.replacement_owner_user_id
        AND NEW.role = 'owner'
    ) INTO is_owner_transfer;
  ELSIF TG_OP = 'UPDATE' THEN
    -- The internal capability never grants a generic entitlement bypass. It
    -- matches only the two exact role changes performed by the transfer
    -- function: replacement -> owner, then previous owner -> admin.
    SELECT EXISTS (
      SELECT 1
      FROM business_group_owner_transfer_context transfer_context
      WHERE transfer_context.transaction_id = txid_current()
        AND transfer_context.group_id = locked_group_id
        AND transfer_context.actor_user_id = current_user_id()
        AND (
          (
            NEW.user_id = transfer_context.replacement_owner_user_id
            AND OLD.role <> 'owner'
            AND NEW.role = 'owner'
          )
          OR (
            OLD.user_id = transfer_context.previous_owner_user_id
            AND OLD.role = 'owner'
            AND NEW.role = 'admin'
          )
        )
    ) INTO is_owner_transfer;

    SELECT EXISTS (
      SELECT 1
      FROM business_group_owner_transfer_context transfer_context
      WHERE transfer_context.transaction_id = txid_current()
        AND transfer_context.group_id = locked_group_id
        AND transfer_context.actor_user_id = current_user_id()
        AND OLD.user_id = transfer_context.previous_owner_user_id
        AND OLD.role = 'owner'
        AND NEW.role = 'admin'
    ) INTO is_previous_owner_transfer_step;
  END IF;

  IF current_user_id() IS NOT NULL THEN
    IF NOT (
      TG_OP = 'INSERT'
      AND NEW.role = 'owner'
      AND can_bootstrap_organization_group(locked_group_id, NEW.user_id)
    )
    AND NOT can_manage_organization_group(locked_group_id)
    THEN
      RAISE EXCEPTION
        'The current actor no longer has composed Business Group manager access';
    END IF;

    IF (
      (TG_OP = 'INSERT' AND NEW.role = 'owner')
      OR (TG_OP = 'UPDATE' AND (OLD.role = 'owner' OR NEW.role = 'owner'))
      OR (TG_OP = 'DELETE' AND OLD.role = 'owner')
    )
    AND NOT (
      TG_OP = 'INSERT'
      AND NEW.role = 'owner'
      AND can_bootstrap_organization_group(locked_group_id, NEW.user_id)
    )
    AND NOT can_manage_organization_group_owners(locked_group_id)
    THEN
      RAISE EXCEPTION
        'Only a current composed Business Group owner can change owner access';
    END IF;
  END IF;

  IF is_owner_transfer
     AND NOT is_eligible_organization_group_owner(
       locked_group_id,
       current_user_id()
     )
  THEN
    RAISE EXCEPTION
      'Ownership transfer requires an eligible current owner';
  END IF;

  IF is_previous_owner_transfer_step
     AND NOT EXISTS (
       SELECT 1
       FROM organization_group_members replacement_owner
       INNER JOIN business_group_owner_transfer_context transfer_context
         ON transfer_context.transaction_id = txid_current()
        AND transfer_context.group_id = replacement_owner.group_id
        AND transfer_context.replacement_owner_user_id = replacement_owner.user_id
       WHERE replacement_owner.group_id = locked_group_id
         AND replacement_owner.role = 'owner'
     )
  THEN
    RAISE EXCEPTION
      'Ownership transfer must establish the replacement owner before demoting the previous owner';
  END IF;

  IF NOT is_access_reduction AND NOT is_owner_transfer THEN
    IF EXISTS (
      SELECT 1
      FROM organization_groups groups
      WHERE groups.id = locked_group_id
        AND groups.status = 'archived'
    ) THEN
      RAISE EXCEPTION
        'An archived Business Group permits only membership access reduction until it is restored';
    END IF;

    IF NOT has_active_business_groups_entitlement(target_account_id) THEN
      RAISE EXCEPTION
        'Business Group membership changes require an active Enterprise entitlement';
    END IF;
  END IF;

  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role <> 'owner')
  THEN
    IF OLD.role = 'owner'
       AND is_eligible_organization_group_owner(OLD.group_id, OLD.user_id)
       AND NOT EXISTS (
         SELECT 1
         FROM organization_group_members other_group_owner
         INNER JOIN organization_groups groups
           ON groups.id = other_group_owner.group_id
         INNER JOIN enterprise_account_members other_account_membership
           ON other_account_membership.enterprise_account_id = groups.enterprise_account_id
          AND other_account_membership.user_id = other_group_owner.user_id
          AND other_account_membership.role IN ('owner', 'group_admin')
         WHERE other_group_owner.group_id = OLD.group_id
           AND other_group_owner.role = 'owner'
           AND other_group_owner.id <> OLD.id
       )
    THEN
      RAISE EXCEPTION 'A Business Group must keep at least one eligible owner';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_group_members_admin_guard
  ON organization_group_members;
CREATE TRIGGER organization_group_members_admin_guard
BEFORE INSERT OR UPDATE OR DELETE ON organization_group_members
FOR EACH ROW EXECUTE FUNCTION enforce_organization_group_member_invariants();

-- Recovery-only atomic ownership transfer. This remains usable while an
-- entitlement is locked or the group is archived, but only by the current
-- eligible group owner and only to another eligible Enterprise manager.
CREATE OR REPLACE FUNCTION transfer_organization_group_ownership(
  target_group_id uuid,
  replacement_user_id text,
  support_reference text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id text := current_user_id();
  target_account_id uuid;
  actor_enterprise_role text;
  replacement_enterprise_role text;
  replacement_group_role text;
  locked_enterprise_member record;
  changed_rows integer;
BEGIN
  IF actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Ownership transfer requires an authenticated actor';
  END IF;
  IF replacement_user_id IS NULL OR replacement_user_id = actor_user_id THEN
    RAISE EXCEPTION 'Ownership transfer requires a different replacement user';
  END IF;
  IF support_reference IS NULL
     OR char_length(btrim(support_reference)) NOT BETWEEN 3 AND 255
  THEN
    RAISE EXCEPTION 'Ownership transfer requires a 3 to 255 character support reference';
  END IF;

  SELECT groups.enterprise_account_id
  INTO target_account_id
  FROM organization_groups groups
  WHERE groups.id = target_group_id;
  IF target_account_id IS NULL THEN
    RAISE EXCEPTION 'Ownership transfer requires an existing Business Group';
  END IF;

  -- No child row is owned yet, so use the canonical insert prefix: identities
  -- -> account parent -> group parent -> Enterprise memberships -> allowance.
  PERFORM lock_business_group_user_rows(
    ARRAY[actor_user_id, replacement_user_id]
  );
  IF NOT EXISTS (SELECT 1 FROM auth_users target_user WHERE target_user.id = actor_user_id)
     OR NOT EXISTS (
       SELECT 1 FROM auth_users target_user WHERE target_user.id = replacement_user_id
     )
  THEN
    RAISE EXCEPTION 'Ownership transfer requires two existing users';
  END IF;

  PERFORM 1
  FROM enterprise_accounts account
  WHERE account.id = target_account_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ownership transfer requires an existing Enterprise account';
  END IF;

  PERFORM 1
  FROM organization_groups groups
  WHERE groups.id = target_group_id
    AND groups.enterprise_account_id = target_account_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ownership transfer requires a stable Business Group parent';
  END IF;

  FOR locked_enterprise_member IN
    SELECT account_membership.user_id, account_membership.role
    FROM enterprise_account_members account_membership
    WHERE account_membership.enterprise_account_id = target_account_id
      AND account_membership.user_id IN (actor_user_id, replacement_user_id)
    ORDER BY account_membership.user_id
    FOR UPDATE OF account_membership
  LOOP
    IF locked_enterprise_member.user_id = actor_user_id THEN
      actor_enterprise_role := locked_enterprise_member.role;
    ELSIF locked_enterprise_member.user_id = replacement_user_id THEN
      replacement_enterprise_role := locked_enterprise_member.role;
    END IF;
  END LOOP;

  IF actor_enterprise_role NOT IN ('owner', 'group_admin')
     OR replacement_enterprise_role NOT IN ('owner', 'group_admin')
  THEN
    RAISE EXCEPTION
      'Ownership transfer requires both users to be Enterprise owners or group_admins';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('business-groups:' || target_account_id::text, 0)
  ) THEN
    RAISE EXCEPTION
      'Business Group ownership transfer serialization conflict; retry the entire transaction'
      USING ERRCODE = '40001',
            HINT = 'Retry the complete ownership transfer in a new transaction.';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('business-group-members:' || target_group_id::text, 0)
  );

  IF NOT can_manage_organization_group_owners(target_group_id) THEN
    RAISE EXCEPTION 'Only the current eligible Business Group owner can transfer ownership';
  END IF;

  SELECT group_membership.role
  INTO replacement_group_role
  FROM organization_group_members group_membership
  WHERE group_membership.group_id = target_group_id
    AND group_membership.user_id = replacement_user_id
  FOR UPDATE;

  INSERT INTO business_group_owner_transfer_context (
    transaction_id,
    group_id,
    actor_user_id,
    previous_owner_user_id,
    replacement_owner_user_id
  ) VALUES (
    txid_current(),
    target_group_id,
    actor_user_id,
    actor_user_id,
    replacement_user_id
  );

  IF replacement_group_role IS NULL THEN
    INSERT INTO organization_group_members (group_id, user_id, role)
    VALUES (target_group_id, replacement_user_id, 'owner');
  ELSIF replacement_group_role <> 'owner' THEN
    UPDATE organization_group_members
    SET role = 'owner'
    WHERE group_id = target_group_id
      AND user_id = replacement_user_id;
  END IF;

  UPDATE organization_group_members
  SET role = 'admin'
  WHERE group_id = target_group_id
    AND user_id = actor_user_id
    AND role = 'owner';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'Ownership transfer requires the actor to be a current group owner';
  END IF;

  INSERT INTO organization_group_audit_events (
    enterprise_account_id,
    group_id,
    actor_user_id,
    event_type,
    subject_type,
    subject_id,
    details,
    created_at
  ) VALUES (
    target_account_id,
    target_group_id,
    actor_user_id,
    'group.owner_transferred',
    'user',
    replacement_user_id,
    jsonb_build_object(
      'previousOwnerUserId', actor_user_id,
      'replacementOwnerUserId', replacement_user_id,
      'supportReference', btrim(support_reference)
    ),
    clock_timestamp()
  );

  DELETE FROM business_group_owner_transfer_context transfer_context
  WHERE transfer_context.transaction_id = txid_current()
    AND transfer_context.group_id = target_group_id;
END;
$$;

CREATE OR REPLACE FUNCTION audit_organization_group_member_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_group_id uuid;
  target_user_id text;
  target_account_id uuid;
  audit_actor_user_id text;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    -- An auth-user cascade leaves the group alive and must remain visible in
    -- its audit history. Group/account cascades remove the audit partition and
    -- are skipped to avoid inserting against a parent already being deleted.
    IF EXISTS (SELECT 1 FROM auth_users target_user WHERE target_user.id = OLD.user_id) THEN
      RETURN OLD;
    END IF;
    audit_actor_user_id := NULL;
  ELSE
    audit_actor_user_id := current_user_id();
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  target_group_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  target_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  SELECT groups.enterprise_account_id
  INTO target_account_id
  FROM organization_groups groups
  WHERE groups.id = target_group_id;

  -- A parent account/group cascade deliberately removes the audit partition too.
  IF target_account_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO organization_group_audit_events (
    enterprise_account_id,
    group_id,
    actor_user_id,
    event_type,
    subject_type,
    subject_id,
    details,
    created_at
  ) VALUES (
    target_account_id,
    target_group_id,
    audit_actor_user_id,
    CASE
      WHEN TG_OP = 'INSERT' THEN 'member.added'
      WHEN TG_OP = 'UPDATE' THEN 'member.role_changed'
      ELSE 'member.removed'
    END,
    'user',
    target_user_id,
    CASE
      WHEN TG_OP = 'INSERT' THEN
        jsonb_build_object('previousRole', NULL, 'role', NEW.role)
      WHEN TG_OP = 'UPDATE' THEN
        jsonb_build_object('previousRole', OLD.role, 'role', NEW.role)
      ELSE
        jsonb_build_object('role', OLD.role)
    END,
    clock_timestamp()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_group_members_audit
  ON organization_group_members;
CREATE TRIGGER organization_group_members_audit
AFTER INSERT OR UPDATE OR DELETE ON organization_group_members
FOR EACH ROW EXECUTE FUNCTION audit_organization_group_member_change();

CREATE OR REPLACE FUNCTION guard_enterprise_membership_owned_groups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_group record;
BEGIN
  -- Direct key changes could silently re-bind every dependent authorization
  -- decision. Parent cascades use DELETE, so there is no legitimate exception.
  IF TG_OP = 'UPDATE'
     AND (
       NEW.enterprise_account_id IS DISTINCT FROM OLD.enterprise_account_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
     )
  THEN
    RAISE EXCEPTION
      'Enterprise membership enterprise_account_id and user_id are immutable';
  END IF;

  -- A user/account parent row owns its cascade. The auth_users parent trigger
  -- still prevents deletion of the final eligible group owner.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NOT (
       OLD.role IN ('owner', 'group_admin')
       AND NEW.role NOT IN ('owner', 'group_admin')
     )
  THEN
    RETURN NEW;
  END IF;

  -- The Enterprise row is already locked by UPDATE/DELETE. Take the account
  -- namespace next, followed by sorted group namespaces, matching member
  -- insert/promotion revalidation and avoiding cross-group lock cycles.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('business-groups:' || OLD.enterprise_account_id::text, 0)
  ) THEN
    RAISE EXCEPTION
      'Enterprise membership serialization conflict; retry the entire transaction'
      USING ERRCODE = '40001',
            HINT = 'Retry the complete Enterprise membership mutation in a new transaction.';
  END IF;

  FOR account_group IN
    SELECT groups.id AS group_id
    FROM organization_groups groups
    WHERE groups.enterprise_account_id = OLD.enterprise_account_id
    ORDER BY groups.id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('business-group-members:' || account_group.group_id::text, 0)
    );
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM organization_group_members group_membership
      INNER JOIN organization_groups groups
        ON groups.id = group_membership.group_id
      WHERE groups.enterprise_account_id = OLD.enterprise_account_id
        AND group_membership.user_id = OLD.user_id
    )
    THEN
      RAISE EXCEPTION
        'Remove Business Group memberships before deleting an Enterprise membership';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.role IN ('owner', 'group_admin')
     AND NEW.role = 'billing_admin'
     AND EXISTS (
       SELECT 1
       FROM organization_group_members group_membership
       INNER JOIN organization_groups groups
         ON groups.id = group_membership.group_id
       WHERE groups.enterprise_account_id = OLD.enterprise_account_id
         AND group_membership.user_id = OLD.user_id
         AND group_membership.role = 'owner'
     )
  THEN
    RAISE EXCEPTION
      'Transfer or demote Business Group owner roles before changing the Enterprise membership to billing_admin';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enterprise_account_members_owned_groups_guard
  ON enterprise_account_members;
CREATE TRIGGER enterprise_account_members_owned_groups_guard
BEFORE UPDATE OF enterprise_account_id, user_id, role OR DELETE ON enterprise_account_members
FOR EACH ROW EXECUTE FUNCTION guard_enterprise_membership_owned_groups();

CREATE OR REPLACE FUNCTION guard_user_owned_business_groups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  owned_account record;
  owned_group record;
BEGIN
  -- The auth parent row is already owned by DELETE. Serialize every account
  -- and group in which this identity participates, not only eligible-owner
  -- rows: a concurrent mutation must revalidate this actor after these locks.
  FOR owned_account IN
    SELECT DISTINCT groups.enterprise_account_id
    FROM organization_group_members group_membership
    INNER JOIN organization_groups groups ON groups.id = group_membership.group_id
    WHERE group_membership.user_id = OLD.id
    ORDER BY groups.enterprise_account_id
  LOOP
    IF NOT pg_try_advisory_xact_lock(
      hashtextextended('business-groups:' || owned_account.enterprise_account_id::text, 0)
    ) THEN
      RAISE EXCEPTION
        'User deletion serialization conflict; retry the entire transaction'
        USING ERRCODE = '40001',
              HINT = 'Retry the complete user deletion in a new transaction.';
    END IF;
  END LOOP;

  FOR owned_group IN
    SELECT DISTINCT group_membership.group_id
    FROM organization_group_members group_membership
    WHERE group_membership.user_id = OLD.id
    ORDER BY group_membership.group_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('business-group-members:' || owned_group.group_id::text, 0)
    );
  END LOOP;

  -- After all affected namespaces are held, enforce the final eligible-owner
  -- invariant for the subset of groups where this user currently qualifies.
  FOR owned_group IN
    SELECT group_membership.group_id
    FROM organization_group_members group_membership
    INNER JOIN organization_groups groups ON groups.id = group_membership.group_id
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
     AND account_membership.user_id = group_membership.user_id
     AND account_membership.role IN ('owner', 'group_admin')
    WHERE group_membership.user_id = OLD.id
      AND group_membership.role = 'owner'
    ORDER BY group_membership.group_id
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM organization_group_members other_group_owner
      INNER JOIN organization_groups groups ON groups.id = other_group_owner.group_id
      INNER JOIN enterprise_account_members other_account_membership
        ON other_account_membership.enterprise_account_id = groups.enterprise_account_id
       AND other_account_membership.user_id = other_group_owner.user_id
       AND other_account_membership.role IN ('owner', 'group_admin')
      WHERE other_group_owner.group_id = owned_group.group_id
        AND other_group_owner.role = 'owner'
        AND other_group_owner.user_id <> OLD.id
    ) THEN
      RAISE EXCEPTION
        'User deletion would leave Business Group % without an eligible owner',
        owned_group.group_id;
    END IF;
  END LOOP;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS auth_users_owned_business_groups_guard ON auth_users;
CREATE TRIGGER auth_users_owned_business_groups_guard
BEFORE DELETE ON auth_users
FOR EACH ROW EXECUTE FUNCTION guard_user_owned_business_groups();

DROP POLICY IF EXISTS organization_group_members_group_insert ON organization_group_members;
DROP POLICY IF EXISTS organization_group_members_group_update ON organization_group_members;
DROP POLICY IF EXISTS organization_group_members_group_delete ON organization_group_members;

CREATE POLICY organization_group_members_group_insert
ON organization_group_members FOR INSERT
WITH CHECK (
  (
    role <> 'owner'
    AND is_enterprise_organization_group_member(group_id, user_id)
    AND can_manage_organization_group(group_id)
  )
  OR (
    role = 'owner'
    AND is_eligible_organization_group_owner(group_id, user_id)
    AND (
      can_manage_organization_group_owners(group_id)
      OR can_bootstrap_organization_group(group_id, user_id)
    )
  )
);

CREATE POLICY organization_group_members_group_update
ON organization_group_members FOR UPDATE
USING (
  (role <> 'owner' AND can_manage_organization_group(group_id))
  OR (role = 'owner' AND can_manage_organization_group_owners(group_id))
)
WITH CHECK (
  (
    role <> 'owner'
    AND is_enterprise_organization_group_member(group_id, user_id)
    AND can_manage_organization_group(group_id)
  )
  OR (
    role = 'owner'
    AND can_manage_organization_group_owners(group_id)
    AND is_eligible_organization_group_owner(group_id, user_id)
  )
);

CREATE POLICY organization_group_members_group_delete
ON organization_group_members FOR DELETE
USING (
  (role <> 'owner' AND can_manage_organization_group(group_id))
  OR (role = 'owner' AND can_manage_organization_group_owners(group_id))
);

-- Group audit rows are emitted only by SECURITY DEFINER lifecycle triggers,
-- and entitlement history is operator-written. Projection reconciliation is
-- runtime-writeable but append-only. Replace any legacy broad grants with the
-- exact evidence-table capabilities so runtime users cannot rewrite or
-- truncate history.
DROP POLICY IF EXISTS organization_group_audit_events_group_insert
  ON organization_group_audit_events;

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE organization_group_audit_events FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT ON TABLE organization_group_audit_events TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON TABLE entitlement_events FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT ON TABLE entitlement_events TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON TABLE business_group_projection_reconciliation_events FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE business_group_projection_reconciliation_events TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION lock_business_group_user_rows(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_enterprise_organization_group_member(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION has_active_business_groups_entitlement(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_eligible_organization_group_owner(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION can_manage_organization_group(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION can_manage_organization_group_owners(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION can_bootstrap_organization_group(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION transfer_organization_group_ownership(uuid, text, text) FROM PUBLIC;

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE business_group_owner_transfer_context FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION transfer_organization_group_ownership(uuid, text, text) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION lock_business_group_user_rows(text[]) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION has_active_business_groups_entitlement(uuid) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION is_enterprise_organization_group_member(uuid, text) TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION is_eligible_organization_group_owner(uuid, text) TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION can_manage_organization_group(uuid) TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION can_manage_organization_group_owners(uuid) TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION can_bootstrap_organization_group(uuid, text) TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$$;
