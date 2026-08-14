import postgres, { type Sql, type TransactionSql } from "postgres";
import type { DatabaseTarget } from "@/lib/database-target";
import { getPostgresOptionsForDatabaseTarget } from "@/lib/database-target-internal";
import type {
  MigrationEngineAdapter,
  MigrationHistoryRow,
  MigrationTransaction,
  MigrationVerification,
  PreparedMigration,
  VerificationContext,
} from "./engine";
import { migrationVerifierRegistry, validateVerifierRegistry } from "./verifiers/registry";
import type { VerificationQuery } from "./verifiers/types";

const GLOBAL_LOCK_KEY = "buwiz:manual-migration-lifecycle:v1";
const SECURE_SEARCH_PATH = "pg_catalog, public";

const COMPATIBILITY_0028_STATE_SQL = String.raw`
/* compatibility state for migration 0028 */
WITH target AS (
  SELECT to_regclass('public.organization_group_entities') AS oid
)
SELECT
  target.oid IS NOT NULL AS entities_table,
  (SELECT format_type(attribute.atttypid, attribute.atttypmod)
     FROM pg_attribute AS attribute
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'parent_entity_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS parent_column_type,
  (SELECT attribute.attnotnull
     FROM pg_attribute AS attribute
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'parent_entity_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS parent_column_not_null,
  (SELECT pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true)
     FROM pg_catalog.pg_attribute AS attribute
     LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
       ON attribute_default.adrelid = attribute.attrelid
      AND attribute_default.adnum = attribute.attnum
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'parent_entity_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS parent_column_default,
  (SELECT attribute.attidentity::text
     FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'parent_entity_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS parent_column_identity,
  (SELECT attribute.attgenerated::text
     FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'parent_entity_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS parent_column_generated,
  (SELECT format_type(attribute.atttypid, attribute.atttypmod)
     FROM pg_attribute AS attribute
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_type,
  (SELECT attribute.attnotnull
     FROM pg_attribute AS attribute
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_not_null,
  (SELECT pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true)
     FROM pg_catalog.pg_attribute AS attribute
     LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
       ON attribute_default.adrelid = attribute.attrelid
      AND attribute_default.adnum = attribute.attnum
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_default,
  (SELECT attribute.attidentity::text
     FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_identity,
  (SELECT attribute.attgenerated::text
     FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = target.oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_generated,
  (SELECT pg_get_constraintdef(oid, true) FROM pg_constraint
    WHERE conrelid = target.oid
      AND conname = 'organization_group_entities_not_own_parent_check') AS parent_check_definition,
  (SELECT pg_get_constraintdef(oid, true) FROM pg_constraint
    WHERE conrelid = target.oid
      AND conname = 'organization_group_entities_group_id_id_unique') AS group_id_unique_definition,
  (SELECT pg_get_constraintdef(oid, true) FROM pg_constraint
    WHERE conrelid = target.oid
      AND conname = 'organization_group_entities_same_group_parent_fk') AS parent_fk_definition,
  (SELECT pg_get_indexdef(indexname::regclass) FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'organization_group_entities_group_parent_idx') AS parent_index_definition
FROM target
`;

interface Compatibility0028State {
  entities_table: boolean;
  parent_column_type: string | null;
  parent_column_not_null: boolean | null;
  parent_column_default: string | null;
  parent_column_identity: string | null;
  parent_column_generated: string | null;
  enterprise_column_type: string | null;
  enterprise_column_not_null: boolean | null;
  enterprise_column_default: string | null;
  enterprise_column_identity: string | null;
  enterprise_column_generated: string | null;
  parent_check_definition: string | null;
  group_id_unique_definition: string | null;
  parent_fk_definition: string | null;
  parent_index_definition: string | null;
}

function isPlainColumnMetadata(
  defaultExpression: string | null,
  identityKind: string | null,
  generatedKind: string | null,
): boolean {
  return (
    defaultExpression === null &&
    (identityKind === null || identityKind === "") &&
    (generatedKind === null || generatedKind === "")
  );
}

async function prepare0028(sql: QuerySql): Promise<void> {
  const [state] = await sql.unsafe<Compatibility0028State[]>(COMPATIBILITY_0028_STATE_SQL);
  if (!state) {
    throw new Error("Migration 0028 compatibility catalog query returned no state.");
  }
  if (!state.entities_table) return;

  const parentObjects = [
    state.parent_check_definition,
    state.group_id_unique_definition,
    state.parent_fk_definition,
    state.parent_index_definition,
  ];
  const exactExistingParent =
    state.parent_column_type === "uuid" &&
    state.parent_column_not_null === false &&
    isPlainColumnMetadata(
      state.parent_column_default,
      state.parent_column_identity,
      state.parent_column_generated,
    ) &&
    parentObjects.every((value) => value === null) &&
    isPlainColumnMetadata(
      state.enterprise_column_default,
      state.enterprise_column_identity,
      state.enterprise_column_generated,
    ) &&
    ((state.enterprise_column_type === null && state.enterprise_column_not_null === null) ||
      (state.enterprise_column_type === "uuid" && state.enterprise_column_not_null === true));
  if (exactExistingParent) return;

  const exactFresh =
    state.parent_column_type === null &&
    state.parent_column_not_null === null &&
    state.parent_column_default === null &&
    state.parent_column_identity === null &&
    state.parent_column_generated === null &&
    parentObjects.every((value) => value === null) &&
    state.enterprise_column_type === "uuid" &&
    state.enterprise_column_not_null === true &&
    isPlainColumnMetadata(
      state.enterprise_column_default,
      state.enterprise_column_identity,
      state.enterprise_column_generated,
    );
  if (!exactFresh) {
    throw new Error(
      "Migration 0028 compatibility state is ambiguous or partial; no compatibility DDL was executed.",
    );
  }

  await sql.unsafe(
    "ALTER TABLE public.organization_group_entities ADD COLUMN parent_entity_id uuid;",
  );
}

const COMPATIBILITY_0029_STATE_SQL = String.raw`
/* compatibility state for migration 0029 */
WITH targets AS (
  SELECT
    to_regclass('public.organization_group_entities') AS entities_oid,
    to_regclass('public.organization_groups') AS groups_oid
),
account_group_constraint AS (
  SELECT constraint_row.*
  FROM pg_constraint AS constraint_row, targets
  WHERE constraint_row.conrelid = targets.entities_oid
    AND constraint_row.conname = 'organization_group_entities_account_group_fk'
),
enabled_index AS (
  SELECT index_meta.*, index_row.oid AS index_oid, index_row.relam
  FROM pg_index AS index_meta
  JOIN pg_class AS index_row ON index_row.oid = index_meta.indexrelid
  JOIN targets ON targets.entities_oid = index_meta.indrelid
  WHERE index_row.relname = 'organization_group_entities_account_org_enabled_unique'
),
  group_unique_constraint AS (
  SELECT constraint_row.*
  FROM pg_constraint AS constraint_row, targets
  WHERE constraint_row.conrelid = targets.groups_oid
      AND constraint_row.conname = 'organization_groups_account_id_unique'
  ),
  unknown_enterprise_constraints AS (
    SELECT count(*)::integer AS count
    FROM pg_catalog.pg_constraint AS constraint_row, targets
    WHERE constraint_row.conrelid = targets.entities_oid
      AND constraint_row.conname <> 'organization_group_entities_account_group_fk'
      AND EXISTS (
        SELECT 1
        FROM unnest(constraint_row.conkey) AS key(attnum)
        INNER JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key.attnum
        WHERE attribute.attname = 'enterprise_account_id'
      )
  ),
  unknown_enterprise_indexes AS (
    SELECT count(*)::integer AS count
    FROM pg_catalog.pg_index AS index_meta
    INNER JOIN pg_catalog.pg_class AS index_row
      ON index_row.oid = index_meta.indexrelid
    CROSS JOIN targets
    WHERE index_meta.indrelid = targets.entities_oid
      AND index_row.relname <> 'organization_group_entities_account_org_enabled_unique'
      AND (
        EXISTS (
        SELECT 1
        FROM unnest(index_meta.indkey) AS key(attnum)
        INNER JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_meta.indrelid
         AND attribute.attnum = key.attnum
        WHERE attribute.attname = 'enterprise_account_id'
        )
        OR pg_catalog.pg_get_indexdef(index_row.oid, 0, true)
           ILIKE '%enterprise_account_id%'
      )
  )
SELECT
  targets.entities_oid IS NOT NULL AS entities_table,
  targets.groups_oid IS NOT NULL AS groups_table,
  (SELECT format_type(attribute.atttypid, attribute.atttypmod)
     FROM pg_attribute AS attribute
    WHERE attribute.attrelid = targets.entities_oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_type,
  (SELECT attribute.attnotnull
     FROM pg_attribute AS attribute
    WHERE attribute.attrelid = targets.entities_oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_not_null,
  (SELECT pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true)
     FROM pg_catalog.pg_attribute AS attribute
     LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
       ON attribute_default.adrelid = attribute.attrelid
      AND attribute_default.adnum = attribute.attnum
    WHERE attribute.attrelid = targets.entities_oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_default,
  (SELECT attribute.attidentity::text
     FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = targets.entities_oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_identity,
  (SELECT attribute.attgenerated::text
     FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = targets.entities_oid
      AND attribute.attname = 'enterprise_account_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped) AS enterprise_column_generated,
  (SELECT count FROM unknown_enterprise_constraints) AS "unknownEnterpriseConstraintCount",
  (SELECT count FROM unknown_enterprise_indexes) AS "unknownEnterpriseIndexCount",
  (SELECT CASE contype WHEN 'f' THEN 'foreign_key' ELSE contype::text END
     FROM account_group_constraint) AS account_group_constraint_type,
  (SELECT ARRAY(
      SELECT attribute.attname
      FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key.attnum
      ORDER BY key.position)
     FROM account_group_constraint AS constraint_row) AS account_group_columns,
  (SELECT referenced_namespace.nspname
     FROM account_group_constraint AS constraint_row
     JOIN pg_class AS referenced ON referenced.oid = constraint_row.confrelid
     JOIN pg_namespace AS referenced_namespace
       ON referenced_namespace.oid = referenced.relnamespace)
    AS account_group_referenced_schema,
  (SELECT referenced.relname
     FROM account_group_constraint AS constraint_row
     JOIN pg_class AS referenced ON referenced.oid = constraint_row.confrelid)
    AS account_group_referenced_table,
  (SELECT ARRAY(
      SELECT attribute.attname
      FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.confrelid
       AND attribute.attnum = key.attnum
      ORDER BY key.position)
     FROM account_group_constraint AS constraint_row) AS account_group_referenced_columns,
  (SELECT CASE confmatchtype
      WHEN 's' THEN 'simple' WHEN 'f' THEN 'full' WHEN 'p' THEN 'partial'
      ELSE confmatchtype::text END
     FROM account_group_constraint) AS account_group_match_type,
  (SELECT CASE confupdtype
      WHEN 'c' THEN 'cascade' WHEN 'r' THEN 'restrict' WHEN 'a' THEN 'no_action'
      WHEN 'n' THEN 'set_null' WHEN 'd' THEN 'set_default' ELSE confupdtype::text END
     FROM account_group_constraint) AS account_group_on_update,
  (SELECT CASE confdeltype
      WHEN 'c' THEN 'cascade' WHEN 'r' THEN 'restrict' WHEN 'a' THEN 'no_action'
      WHEN 'n' THEN 'set_null' WHEN 'd' THEN 'set_default' ELSE confdeltype::text END
     FROM account_group_constraint) AS account_group_on_delete,
  (SELECT condeferrable FROM account_group_constraint) AS account_group_deferrable,
  (SELECT condeferred FROM account_group_constraint) AS account_group_initially_deferred,
  (SELECT convalidated FROM account_group_constraint) AS account_group_validated,
  (SELECT indisunique FROM enabled_index) AS enabled_index_unique,
  (SELECT indisprimary FROM enabled_index) AS enabled_index_primary,
  (SELECT indisvalid FROM enabled_index) AS enabled_index_valid,
  (SELECT indisready FROM enabled_index) AS enabled_index_ready,
  (SELECT access_method.amname FROM enabled_index
     JOIN pg_am AS access_method ON access_method.oid = enabled_index.relam)
    AS enabled_index_method,
  (SELECT ARRAY(
      SELECT pg_get_indexdef(enabled_index.index_oid, positions.position, true)
      FROM generate_series(1, enabled_index.indnkeyatts) AS positions(position)
      ORDER BY positions.position)
     FROM enabled_index) AS enabled_index_columns,
  (SELECT ARRAY(
      SELECT pg_get_indexdef(enabled_index.index_oid, positions.position, true)
      FROM generate_series(enabled_index.indnkeyatts + 1, enabled_index.indnatts)
        AS positions(position)
      ORDER BY positions.position)
     FROM enabled_index) AS enabled_index_include_columns,
  (SELECT pg_get_expr(enabled_index.indpred, enabled_index.indrelid, true)
     FROM enabled_index) AS enabled_index_predicate,
  (SELECT CASE contype WHEN 'u' THEN 'unique' ELSE contype::text END
     FROM group_unique_constraint) AS group_unique_constraint_type,
  (SELECT ARRAY(
      SELECT attribute.attname
      FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key.attnum
     ORDER BY key.position)
     FROM group_unique_constraint AS constraint_row) AS group_unique_columns,
  (SELECT condeferrable FROM group_unique_constraint) AS group_unique_deferrable,
  (SELECT condeferred FROM group_unique_constraint) AS group_unique_initially_deferred,
  (SELECT convalidated FROM group_unique_constraint) AS group_unique_validated
FROM targets
`;

interface Compatibility0029State {
  entities_table: boolean;
  groups_table: boolean;
  enterprise_column_type: string | null;
  enterprise_column_not_null: boolean | null;
  enterprise_column_default: string | null;
  enterprise_column_identity: string | null;
  enterprise_column_generated: string | null;
  unknownEnterpriseConstraintCount: number;
  unknownEnterpriseIndexCount: number;
  account_group_constraint_type: string | null;
  account_group_columns: string[] | null;
  account_group_referenced_schema: string | null;
  account_group_referenced_table: string | null;
  account_group_referenced_columns: string[] | null;
  account_group_match_type: string | null;
  account_group_on_update: string | null;
  account_group_on_delete: string | null;
  account_group_deferrable: boolean | null;
  account_group_initially_deferred: boolean | null;
  account_group_validated: boolean | null;
  enabled_index_unique: boolean | null;
  enabled_index_primary: boolean | null;
  enabled_index_valid: boolean | null;
  enabled_index_ready: boolean | null;
  enabled_index_method: string | null;
  enabled_index_columns: string[] | null;
  enabled_index_include_columns: string[] | null;
  enabled_index_predicate: string | null;
  group_unique_constraint_type: string | null;
  group_unique_columns: string[] | null;
  group_unique_deferrable: boolean | null;
  group_unique_initially_deferred: boolean | null;
  group_unique_validated: boolean | null;
}

function sameArray(actual: readonly string[] | null, expected: readonly string[]): boolean {
  return (
    actual !== null &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function normalizedPredicate(predicate: string | null): string | null {
  return (
    predicate
      ?.replace(/[()]/g, "")
      .replace(/::(?:character varying|text)/g, "")
      .replace(/\s+/g, " ")
      .trim() ?? null
  );
}

async function prepare0029(sql: QuerySql): Promise<void> {
  const [state] = await sql.unsafe<Compatibility0029State[]>(COMPATIBILITY_0029_STATE_SQL);
  if (!state) {
    throw new Error("Migration 0029 compatibility catalog query returned no state.");
  }
  if (!state.entities_table || !state.groups_table) {
    throw new Error("Migration 0029 compatibility state is missing a required table.");
  }

  const companionValues = [
    state.account_group_constraint_type,
    state.account_group_columns,
    state.account_group_referenced_schema,
    state.account_group_referenced_table,
    state.account_group_referenced_columns,
    state.account_group_match_type,
    state.account_group_on_update,
    state.account_group_on_delete,
    state.account_group_deferrable,
    state.account_group_initially_deferred,
    state.account_group_validated,
    state.enabled_index_unique,
    state.enabled_index_primary,
    state.enabled_index_valid,
    state.enabled_index_ready,
    state.enabled_index_method,
    state.enabled_index_columns,
    state.enabled_index_include_columns,
    state.enabled_index_predicate,
    state.group_unique_constraint_type,
    state.group_unique_columns,
    state.group_unique_deferrable,
    state.group_unique_initially_deferred,
    state.group_unique_validated,
  ];
  const exactLegacy =
    state.enterprise_column_type === null &&
    state.enterprise_column_not_null === null &&
    isPlainColumnMetadata(
      state.enterprise_column_default,
      state.enterprise_column_identity,
      state.enterprise_column_generated,
    ) &&
    state.unknownEnterpriseConstraintCount === 0 &&
    state.unknownEnterpriseIndexCount === 0 &&
    companionValues.every((value) => value === null);
  if (exactLegacy) return;

  const exactCurrent =
    state.enterprise_column_type === "uuid" &&
    state.enterprise_column_not_null === true &&
    isPlainColumnMetadata(
      state.enterprise_column_default,
      state.enterprise_column_identity,
      state.enterprise_column_generated,
    ) &&
    state.unknownEnterpriseConstraintCount === 0 &&
    state.unknownEnterpriseIndexCount === 0 &&
    state.account_group_constraint_type === "foreign_key" &&
    sameArray(state.account_group_columns, ["enterprise_account_id", "group_id"]) &&
    state.account_group_referenced_schema === "public" &&
    state.account_group_referenced_table === "organization_groups" &&
    sameArray(state.account_group_referenced_columns, ["enterprise_account_id", "id"]) &&
    state.account_group_match_type === "simple" &&
    state.account_group_on_update === "no_action" &&
    state.account_group_on_delete === "cascade" &&
    state.account_group_deferrable === false &&
    state.account_group_initially_deferred === false &&
    state.account_group_validated === true &&
    state.enabled_index_unique === true &&
    state.enabled_index_primary === false &&
    state.enabled_index_valid === true &&
    state.enabled_index_ready === true &&
    state.enabled_index_method === "btree" &&
    sameArray(state.enabled_index_columns, ["enterprise_account_id", "organization_id"]) &&
    sameArray(state.enabled_index_include_columns, []) &&
    normalizedPredicate(state.enabled_index_predicate) === "status = 'enabled'" &&
    state.group_unique_constraint_type === "unique" &&
    sameArray(state.group_unique_columns, ["enterprise_account_id", "id"]) &&
    state.group_unique_deferrable === false &&
    state.group_unique_initially_deferred === false &&
    state.group_unique_validated === true;
  if (!exactCurrent) {
    throw new Error(
      "Migration 0029 compatibility state is ambiguous or partial; no compatibility DDL was executed.",
    );
  }

  await sql.unsafe(
    "ALTER TABLE public.organization_group_entities DROP CONSTRAINT organization_group_entities_account_group_fk;",
  );
  await sql.unsafe("DROP INDEX public.organization_group_entities_account_org_enabled_unique;");
  await sql.unsafe(
    "ALTER TABLE public.organization_group_entities DROP COLUMN enterprise_account_id;",
  );
  await sql.unsafe(
    "ALTER TABLE public.organization_groups DROP CONSTRAINT organization_groups_account_id_unique;",
  );
}

type QuerySql = Sql | TransactionSql;

type CompatibilityPreparer = (sql: QuerySql) => Promise<void>;

const compatibilityPreparers: Partial<Record<PreparedMigration["id"], CompatibilityPreparer>> = {
  "0028": prepare0028,
  "0029": prepare0029,
};

async function prepareExecution(sql: QuerySql, migration: PreparedMigration): Promise<void> {
  await compatibilityPreparers[migration.id]?.(sql);
}

function queryAdapter(sql: QuerySql): VerificationQuery {
  return {
    async unsafe<T>(statement: string): Promise<T[]> {
      return (await sql.unsafe(statement)) as unknown as T[];
    },
  };
}

function verifierFor(migration: PreparedMigration) {
  return migrationVerifierRegistry[migration.id];
}

export interface PostgresMigrationAdapterOptions {
  target: DatabaseTarget;
  createClient?: () => Sql;
}

interface MigrationHistoryColumnCatalogState {
  name: string;
  type: string;
  notNull: boolean;
  defaultExpression: string | null;
  identityKind: string;
  generatedKind: string;
}

interface MigrationHistoryCatalogState {
  relationKind: string;
  relationPersistence: string;
  rowSecurityEnabled: boolean;
  forceRowSecurity: boolean;
  rewriteRuleCount: number;
  userTriggerCount: number;
  columns: MigrationHistoryColumnCatalogState[];
  primaryKeyCount: number;
  primaryKeyColumns: string[];
  primaryKeyDeferrable: boolean;
}

function incompatibleMigrationHistory(reason: string): never {
  throw new Error(
    `Migration history relation public.app_manual_migrations is ambiguous or incompatible: ${reason}.`,
  );
}

function normalizedDefaultExpression(expression: string | null): string | null {
  return expression === null ? null : expression.replace(/\s+/g, "").toLowerCase();
}

function assertMigrationHistoryCatalog(state: MigrationHistoryCatalogState): void {
  if (state.relationKind !== "r") {
    incompatibleMigrationHistory("the relation is not an ordinary table");
  }
  if (state.relationPersistence !== "p") {
    incompatibleMigrationHistory("the relation is not permanently stored");
  }
  if (
    typeof state.rowSecurityEnabled !== "boolean" ||
    typeof state.forceRowSecurity !== "boolean" ||
    !Number.isInteger(state.rewriteRuleCount) ||
    state.rewriteRuleCount < 0 ||
    !Number.isInteger(state.userTriggerCount) ||
    state.userTriggerCount < 0
  ) {
    incompatibleMigrationHistory("the catalog returned malformed security metadata");
  }
  if (state.rowSecurityEnabled || state.forceRowSecurity) {
    incompatibleMigrationHistory("row-level security is enabled on the history table");
  }
  if (state.rewriteRuleCount !== 0) {
    incompatibleMigrationHistory("the history table has rewrite rules");
  }
  if (state.userTriggerCount !== 0) {
    incompatibleMigrationHistory("the history table has user triggers");
  }
  if (!Array.isArray(state.columns)) {
    incompatibleMigrationHistory("the catalog returned malformed column state");
  }

  const expectedColumnNames = ["applied_at", "checksum", "migration_name"];
  const columnsByName = new Map(state.columns.map((column) => [column.name, column]));
  if (
    state.columns.length !== expectedColumnNames.length ||
    columnsByName.size !== expectedColumnNames.length ||
    expectedColumnNames.some((name) => !columnsByName.has(name))
  ) {
    incompatibleMigrationHistory("the active columns do not exactly match the known legacy shape");
  }

  const migrationName = columnsByName.get("migration_name")!;
  const checksum = columnsByName.get("checksum")!;
  const appliedAt = columnsByName.get("applied_at")!;
  if (migrationName.type !== "text") {
    incompatibleMigrationHistory("migration_name is not text");
  }
  if (checksum.type !== "text" && checksum.type !== "character(64)") {
    incompatibleMigrationHistory("checksum is neither text nor character(64)");
  }
  if (appliedAt.type !== "timestamp with time zone") {
    incompatibleMigrationHistory("applied_at is not timestamp with time zone");
  }

  for (const column of state.columns) {
    if (column.notNull !== true) {
      incompatibleMigrationHistory(`${column.name} is nullable`);
    }
    if (column.identityKind !== "" || column.generatedKind !== "") {
      incompatibleMigrationHistory(`${column.name} is generated or identity-backed`);
    }
  }
  if (migrationName.defaultExpression !== null || checksum.defaultExpression !== null) {
    incompatibleMigrationHistory("migration_name or checksum has an unexpected default");
  }
  const appliedAtDefault = normalizedDefaultExpression(appliedAt.defaultExpression);
  if (appliedAtDefault !== "now()" && appliedAtDefault !== "current_timestamp") {
    incompatibleMigrationHistory("applied_at does not default to now/current_timestamp");
  }
  if (
    state.primaryKeyCount !== 1 ||
    !Array.isArray(state.primaryKeyColumns) ||
    state.primaryKeyColumns.length !== 1 ||
    state.primaryKeyColumns[0] !== "migration_name"
  ) {
    incompatibleMigrationHistory("migration_name is not the sole primary-key column");
  }
  if (state.primaryKeyDeferrable !== false) {
    incompatibleMigrationHistory("the primary key is deferrable");
  }
}

async function inspectMigrationHistoryTable(sql: QuerySql): Promise<boolean> {
  const [state] = await sql<MigrationHistoryCatalogState[]>`
    /* migration history relation contract */
    WITH target AS (
      SELECT relation.oid,
             relation.relkind,
             relation.relpersistence,
             relation.relrowsecurity,
             relation.relforcerowsecurity
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'app_manual_migrations'
    )
    SELECT target.relkind::text AS "relationKind",
           target.relpersistence::text AS "relationPersistence",
           target.relrowsecurity AS "rowSecurityEnabled",
           target.relforcerowsecurity AS "forceRowSecurity",
           (
             SELECT count(*)::integer
             FROM pg_catalog.pg_rewrite AS rewrite_rule
             WHERE rewrite_rule.ev_class = target.oid
           ) AS "rewriteRuleCount",
           (
             SELECT count(*)::integer
             FROM pg_catalog.pg_trigger AS trigger_row
             WHERE trigger_row.tgrelid = target.oid
               AND NOT trigger_row.tgisinternal
           ) AS "userTriggerCount",
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'name', attribute.attname,
                 'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                 'notNull', attribute.attnotnull,
                 'defaultExpression', pg_catalog.pg_get_expr(
                   attribute_default.adbin,
                   attribute_default.adrelid,
                   true
                 ),
                 'identityKind', attribute.attidentity::text,
                 'generatedKind', attribute.attgenerated::text
               )
               ORDER BY attribute.attname
             )
             FROM pg_catalog.pg_attribute AS attribute
             LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
               ON attribute_default.adrelid = attribute.attrelid
              AND attribute_default.adnum = attribute.attnum
             WHERE attribute.attrelid = target.oid
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped
           ), '[]'::jsonb) AS columns,
           (
             SELECT count(*)::integer
             FROM pg_catalog.pg_constraint AS constraint_row
             WHERE constraint_row.conrelid = target.oid
               AND constraint_row.contype = 'p'
           ) AS "primaryKeyCount",
           COALESCE((
             SELECT jsonb_agg(attribute.attname ORDER BY primary_key_column.position)
             FROM pg_catalog.pg_constraint AS constraint_row
             CROSS JOIN LATERAL unnest(constraint_row.conkey)
               WITH ORDINALITY AS primary_key_column(attnum, position)
             INNER JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = constraint_row.conrelid
              AND attribute.attnum = primary_key_column.attnum
             WHERE constraint_row.conrelid = target.oid
               AND constraint_row.contype = 'p'
           ), '[]'::jsonb) AS "primaryKeyColumns",
           COALESCE((
             SELECT bool_or(
               constraint_row.condeferrable OR constraint_row.condeferred
             )
             FROM pg_catalog.pg_constraint AS constraint_row
             WHERE constraint_row.conrelid = target.oid
               AND constraint_row.contype = 'p'
           ), false) AS "primaryKeyDeferrable"
    FROM target
  `;
  if (!state) return false;
  assertMigrationHistoryCatalog(state);

  const [duplicateState] = await sql<{ hasDuplicateNames: boolean }[]>`
    /* migration history duplicate check */
    SELECT EXISTS (
      SELECT 1
      FROM public.app_manual_migrations
      GROUP BY migration_name
      HAVING count(*) > 1
    ) AS "hasDuplicateNames"
  `;
  if (typeof duplicateState?.hasDuplicateNames !== "boolean") {
    incompatibleMigrationHistory("the duplicate-name check returned no state");
  }
  if (duplicateState.hasDuplicateNames) {
    throw new Error("Duplicate migration history names make the history state ambiguous.");
  }
  return true;
}

export function createPostgresMigrationAdapter(
  options: PostgresMigrationAdapterOptions,
): MigrationEngineAdapter & { close(): Promise<void> } {
  if (!options.target) throw new Error("A migration-owner database target is required.");
  const postgresOptions = getPostgresOptionsForDatabaseTarget(options.target, "migration");
  validateVerifierRegistry();

  const rootClient =
    options.createClient?.() ??
    postgres({
      ...postgresOptions,
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
  let lockedClient: Awaited<ReturnType<Sql["reserve"]>> | null = null;
  let historyTableExists: boolean | null = null;
  let closed = false;

  function requireLock(): typeof lockedClient & object {
    if (!lockedClient) {
      throw new Error("Migration database access requires the global lifecycle lock.");
    }
    return lockedClient;
  }

  function requireHistoryTableState(): boolean {
    if (historyTableExists === null) {
      throw new Error("Migration history state was not validated under the global lifecycle lock.");
    }
    return historyTableExists;
  }

  async function readHistoryFrom(sql: QuerySql): Promise<readonly MigrationHistoryRow[]> {
    if (!requireHistoryTableState()) return [];
    return sql<MigrationHistoryRow[]>`
      SELECT migration_name AS "migrationName",
             checksum,
             applied_at AS "appliedAt"
      FROM public.app_manual_migrations
      ORDER BY applied_at, migration_name
    `;
  }

  async function verify(
    sql: QuerySql,
    migration: PreparedMigration,
    context: VerificationContext,
  ): Promise<MigrationVerification> {
    return verifierFor(migration).verify(queryAdapter(sql), context);
  }

  return {
    async withGlobalLock<T>(operation: () => Promise<T>): Promise<T> {
      if (closed) {
        throw new Error("The migration adapter is closed or its connection was poisoned.");
      }
      if (lockedClient) {
        throw new Error("The migration lifecycle lock is already held by this adapter.");
      }
      const reserved = await rootClient.reserve();
      lockedClient = reserved;
      let acquired = false;
      let poisonRequired = false;
      let unlockFailure: unknown;
      let operationResult!: T;
      try {
        await reserved`SELECT pg_catalog.set_config('search_path', ${SECURE_SEARCH_PATH}, false)`;
        await reserved`
          SELECT pg_catalog.pg_advisory_lock(
            pg_catalog.hashtextextended(${GLOBAL_LOCK_KEY}, 0::pg_catalog.int8)
          )
        `;
        acquired = true;
        historyTableExists = await inspectMigrationHistoryTable(reserved);
        operationResult = await operation();
      } catch (error) {
        if (!acquired) poisonRequired = true;
        throw error;
      } finally {
        try {
          if (acquired) {
            try {
              const [unlockState] = await reserved`
                SELECT pg_catalog.pg_advisory_unlock(
                  pg_catalog.hashtextextended(${GLOBAL_LOCK_KEY}, 0::pg_catalog.int8)
                ) AS unlocked
              `;
              if (unlockState?.unlocked !== true) {
                throw new Error("The migration lifecycle advisory lock did not unlock cleanly.");
              }
            } catch (error) {
              poisonRequired = true;
              unlockFailure = error;
            }
          }
        } finally {
          historyTableExists = null;
          lockedClient = null;
          try {
            reserved.release();
          } catch (error) {
            poisonRequired = true;
            unlockFailure ??= error;
          }
          if (poisonRequired) {
            closed = true;
            try {
              await rootClient.end({ timeout: 5 });
            } catch {
              // The original lifecycle failure is more useful to the caller.
            }
          }
        }
      }
      if (unlockFailure !== undefined) throw unlockFailure;
      return operationResult;
    },

    async readHistory() {
      return readHistoryFrom(requireLock());
    },

    async verifyHistoricalState(migration, context) {
      return verify(requireLock(), migration, context);
    },

    async transaction<T>(operation: (tx: MigrationTransaction) => Promise<T>): Promise<T> {
      const reserved = requireLock();
      let historyTableCreated = false;
      const result = await reserved.begin(async (transaction) => {
        const tx: MigrationTransaction = {
          verifyHistoricalState(migration, context) {
            return verify(transaction, migration, context);
          },
          prepareExecution(migration) {
            return prepareExecution(transaction, migration);
          },
          async execute(migration) {
            await transaction.unsafe(migration.executionSql);
          },
          async record(migration) {
            const createHistoryTable = !requireHistoryTableState() && !historyTableCreated;
            if (createHistoryTable) {
              await transaction`
              CREATE TABLE public.app_manual_migrations (
                migration_name text PRIMARY KEY,
                checksum char(64) NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
              )
              `;
              historyTableCreated = true;
            }
            const [row] = await transaction<MigrationHistoryRow[]>`
              INSERT INTO public.app_manual_migrations (migration_name, checksum)
              VALUES (${migration.file}, ${migration.checksum})
              RETURNING migration_name AS "migrationName",
                        checksum,
                        applied_at AS "appliedAt"
            `;
            if (!row) throw new Error(`Migration ${migration.id} history was not recorded.`);
            if (
              row.migrationName !== migration.file ||
              row.checksum.trim() !== migration.checksum
            ) {
              throw new Error(
                `Migration ${migration.id} history row did not match the requested migration.`,
              );
            }
            return row;
          },
        };
        return operation(tx);
      });
      if (historyTableCreated) historyTableExists = true;
      return result as Promise<T>;
    },

    async close() {
      if (lockedClient) {
        throw new Error("Cannot close the migration adapter while its global lock is held.");
      }
      if (closed) return;
      closed = true;
      await rootClient.end({ timeout: 5 });
    },
  };
}
