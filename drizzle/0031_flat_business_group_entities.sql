-- Business Groups are flat reporting portfolios. Parent placement was never
-- consumed by financial reporting and implied a legal/consolidation meaning
-- the product does not implement.

ALTER TABLE organization_group_entities
  DROP CONSTRAINT IF EXISTS organization_group_entities_same_group_parent_fk;

DROP INDEX IF EXISTS organization_group_entities_group_parent_idx;

ALTER TABLE organization_group_entities
  DROP CONSTRAINT IF EXISTS organization_group_entities_not_own_parent_check,
  DROP CONSTRAINT IF EXISTS organization_group_entities_group_id_id_unique,
  DROP COLUMN IF EXISTS parent_entity_id;
