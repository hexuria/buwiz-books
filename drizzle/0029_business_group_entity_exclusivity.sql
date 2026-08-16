-- A business may belong to only one active Business Group per Enterprise account.
-- The account key is denormalized onto the relationship so PostgreSQL can enforce
-- the invariant with a race-safe partial unique index.

ALTER TABLE organization_groups
  ADD CONSTRAINT organization_groups_account_id_unique
  UNIQUE (enterprise_account_id, id);

ALTER TABLE organization_group_entities
  ADD COLUMN enterprise_account_id uuid;

UPDATE organization_group_entities entities
SET enterprise_account_id = groups.enterprise_account_id
FROM organization_groups groups
WHERE groups.id = entities.group_id
  AND entities.enterprise_account_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM organization_group_entities
    WHERE status = 'enabled'
    GROUP BY enterprise_account_id, organization_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Business Group exclusivity migration blocked: an organization is enabled in multiple groups for one Enterprise account';
  END IF;
END
$$;

ALTER TABLE organization_group_entities
  ALTER COLUMN enterprise_account_id SET NOT NULL;

ALTER TABLE organization_group_entities
  ADD CONSTRAINT organization_group_entities_account_group_fk
  FOREIGN KEY (enterprise_account_id, group_id)
  REFERENCES organization_groups (enterprise_account_id, id)
  ON DELETE CASCADE;

CREATE UNIQUE INDEX organization_group_entities_account_org_enabled_unique
  ON organization_group_entities (enterprise_account_id, organization_id)
  WHERE status = 'enabled';

-- Return only a boolean assignment state, and only to an Enterprise member who
-- already has direct membership in the organization. This lets the link picker
-- disable an unavailable business without leaking another group's identity.
CREATE OR REPLACE FUNCTION is_organization_assigned_to_business_group(
  target_account_id uuid,
  target_organization_id text,
  excluded_group_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_enterprise_account_member(target_account_id)
    AND EXISTS (
      SELECT 1
      FROM auth_members membership
      WHERE membership.user_id = current_user_id()
        AND membership.organization_id = target_organization_id
    )
    AND EXISTS (
      SELECT 1
      FROM organization_group_entities entity
      WHERE entity.enterprise_account_id = target_account_id
        AND entity.organization_id = target_organization_id
        AND entity.status = 'enabled'
        AND (excluded_group_id IS NULL OR entity.group_id <> excluded_group_id)
    );
$$;

REVOKE ALL ON FUNCTION is_organization_assigned_to_business_group(uuid, text, uuid) FROM PUBLIC;

DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['app_runtime', 'buwiz_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION is_organization_assigned_to_business_group(uuid, text, uuid) TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$$;
