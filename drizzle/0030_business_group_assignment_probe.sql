-- Make the cross-group assignment probe usable by both request-scoped runtime
-- transactions and explicit administrative/test transactions. Runtime callers
-- cannot probe on behalf of a different user.

DROP FUNCTION is_organization_assigned_to_business_group(uuid, text, uuid);

CREATE FUNCTION is_organization_assigned_to_business_group(
  target_account_id uuid,
  target_organization_id text,
  excluded_group_id uuid,
  target_user_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (current_user_id() IS NULL OR current_user_id() = target_user_id)
    AND EXISTS (
      SELECT 1
      FROM enterprise_account_members account_membership
      WHERE account_membership.enterprise_account_id = target_account_id
        AND account_membership.user_id = target_user_id
    )
    AND EXISTS (
      SELECT 1
      FROM auth_members membership
      WHERE membership.user_id = target_user_id
        AND membership.organization_id = target_organization_id
    )
    AND EXISTS (
      SELECT 1
      FROM organization_group_entities entity
      WHERE entity.enterprise_account_id = target_account_id
        AND entity.organization_id = target_organization_id
        AND entity.status = 'enabled'
        AND entity.group_id <> excluded_group_id
    );
$$;

REVOKE ALL ON FUNCTION is_organization_assigned_to_business_group(uuid, text, uuid, text)
  FROM PUBLIC;

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION is_organization_assigned_to_business_group(uuid, text, uuid, text) TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$$;
