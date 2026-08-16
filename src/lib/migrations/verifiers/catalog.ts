import type { VerificationEvidence } from "../engine";
import { evidence, type VerificationQuery } from "./types";

export type RelationKind = "table" | "partitioned_table";
export type ColumnIdentity = "none" | "always" | "by_default";
export type ColumnGenerated = "none" | "stored";
export type ConstraintType = "check" | "primary_key" | "unique" | "foreign_key" | "exclusion";
export type ReferentialAction = "no_action" | "restrict" | "cascade" | "set_null" | "set_default";
export type MatchType = "simple" | "full" | "partial";
export type FunctionVolatility = "immutable" | "stable" | "volatile";
export type FunctionParallel = "safe" | "restricted" | "unsafe";
export type TriggerEnabled = "disabled" | "origin" | "replica" | "always";
export type TriggerLevel = "row" | "statement";
export type TriggerTiming = "before" | "after" | "instead_of";
export type TriggerEvent = "insert" | "update" | "delete" | "truncate";
export type CatalogObjectType = "schema" | "table" | "sequence" | "function";

export interface SchemaRow {
  name: string;
  owner: string;
}

export interface ColumnRow {
  name: string;
  position: number;
  type: string;
  notNull: boolean;
  defaultExpression: string | null;
  identity: ColumnIdentity;
  generated: ColumnGenerated;
}

export interface RelationRow {
  name: string;
  kind: RelationKind;
  owner: string;
  rls: boolean;
  forceRls: boolean;
  columns: ColumnRow[];
}

export function relationHasColumn(relation: RelationRow | undefined, columnName: string): boolean {
  return relation?.columns.some((column) => column.name === columnName) ?? false;
}

export interface IndexRow {
  tableName: string;
  name: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  ready: boolean;
  accessMethod: string;
  keyExpressions: string[];
  includeExpressions: string[];
  predicate: string | null;
  definition: string;
}

export interface ConstraintRow {
  tableName: string;
  name: string;
  type: ConstraintType;
  columns: string[];
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedColumns: string[];
  matchType: MatchType | null;
  onUpdate: ReferentialAction | null;
  onDelete: ReferentialAction | null;
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
  definition: string;
}

export interface PolicyRow {
  tableName: string;
  name: string;
  permissive: boolean;
  roles: string[];
  command: string;
  using: string | null;
  withCheck: string | null;
}

export interface FunctionRow {
  identity: string;
  resultType: string;
  language: string;
  volatility: FunctionVolatility;
  strict: boolean;
  securityDefiner: boolean;
  parallel: FunctionParallel;
  body: string;
  definition: string;
  config: string[] | null;
  owner: string;
}

export interface TriggerRow {
  identity: string;
  tableName: string;
  name: string;
  enabled: TriggerEnabled;
  level: TriggerLevel;
  timing: TriggerTiming;
  events: TriggerEvent[];
  functionSchema: string;
  functionIdentity: string;
  when: string | null;
  oldTable: string | null;
  newTable: string | null;
  constraint: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
  definition: string;
}

export interface PrivilegeRow {
  objectType: CatalogObjectType;
  objectIdentity: string;
  grantor: string;
  grantee: string;
  privilege: string;
  grantable: boolean;
}

export interface DefaultPrivilegeRow {
  owner: string;
  schema: string | null;
  objectType: CatalogObjectType;
  grantor: string;
  grantee: string;
  privilege: string;
  grantable: boolean;
}

export interface RoleRow {
  name: string;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createDb: boolean;
  canLogin: boolean;
  replication: boolean;
  bypassRls: boolean;
}

export interface CatalogSnapshot {
  schemas: Map<string, SchemaRow>;
  relations: Map<string, RelationRow>;
  indexes: Map<string, IndexRow>;
  constraints: Map<string, ConstraintRow>;
  policies: Map<string, PolicyRow>;
  functions: Map<string, FunctionRow>;
  triggers: Map<string, TriggerRow>;
  extensions: Set<string>;
  enums: Map<string, string[]>;
  privileges: PrivilegeRow[];
  defaultPrivileges: DefaultPrivilegeRow[];
  roles: Map<string, RoleRow>;
}

export interface ColumnExpectation extends Omit<ColumnRow, "position"> {
  position?: number;
}

export interface RelationExpectation {
  name: string;
  kind?: RelationKind;
  owner?: string;
  columns?: readonly ColumnExpectation[] | readonly string[];
  exactColumns?: boolean;
  rls?: boolean;
  forceRls?: boolean;
  /** @deprecated Prefer `rls: false`. */
  noRls?: boolean;
}

export interface IndexExpectation extends Partial<Omit<IndexRow, "name" | "tableName">> {
  name: string;
  tableName?: string;
}

export interface ConstraintExpectation extends Partial<Omit<ConstraintRow, "name" | "tableName">> {
  tableName: string;
  name: string;
}

export interface PolicyExpectation extends Partial<Omit<PolicyRow, "name" | "tableName">> {
  tableName: string;
  name: string;
}

export interface FunctionExpectation extends Partial<Omit<FunctionRow, "identity" | "config">> {
  identity: string;
  searchPath?: readonly string[];
}

export interface TriggerExpectation extends Partial<
  Omit<TriggerRow, "identity" | "name" | "tableName">
> {
  tableName: string;
  name: string;
}

export interface PrivilegeExpectation extends Omit<PrivilegeRow, "grantor" | "grantable"> {
  grantor?: string;
  grantable?: boolean;
  present?: boolean;
}

export interface DefaultPrivilegeExpectation extends Omit<
  DefaultPrivilegeRow,
  "grantor" | "grantable"
> {
  grantor?: string;
  grantable?: boolean;
  present?: boolean;
}

export interface CatalogExpectation {
  schemas?: readonly (SchemaRow & { present?: boolean })[];
  relations?: readonly RelationExpectation[];
  indexes?: readonly IndexExpectation[];
  constraints?: readonly ConstraintExpectation[];
  policies?: readonly PolicyExpectation[];
  functions?: readonly FunctionExpectation[];
  triggers?: readonly TriggerExpectation[];
  extensions?: readonly string[];
  enums?: readonly {
    name: string;
    values: readonly string[];
    exact?: boolean;
  }[];
  privileges?: readonly PrivilegeExpectation[];
  defaultPrivileges?: readonly DefaultPrivilegeExpectation[];
  roles?: readonly (RoleRow & { present?: boolean })[];
}

interface CatalogRows {
  schemas: SchemaRow[];
  relations: Array<{
    name: string;
    kind: RelationKind;
    owner: string;
    rls: boolean;
    forceRls: boolean;
  }>;
  columns: Array<ColumnRow & { table_name: string }>;
  indexes: IndexRow[];
  constraints: ConstraintRow[];
  policies: PolicyRow[];
  functions: FunctionRow[];
  triggers: TriggerRow[];
  extensions: Array<{ name: string }>;
  enums: Array<{ name: string; values: string[] }>;
  privileges: PrivilegeRow[];
  defaultPrivileges: DefaultPrivilegeRow[];
  roles: RoleRow[];
}

const CATALOG_QUERY = String.raw`
WITH
schema_rows AS (
  SELECT
    namespace.nspname AS name,
    pg_get_userbyid(namespace.nspowner) AS owner
  FROM pg_namespace AS namespace
  WHERE namespace.nspname = 'public'
),
relation_rows AS (
  SELECT
    relation.relname AS name,
    CASE relation.relkind
      WHEN 'p' THEN 'partitioned_table'
      ELSE 'table'
    END AS kind,
    pg_get_userbyid(relation.relowner) AS owner,
    relation.relrowsecurity AS rls,
    relation.relforcerowsecurity AS "forceRls"
  FROM pg_class AS relation
  INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
),
column_rows AS (
  SELECT
    relation.relname AS table_name,
    attribute.attname AS name,
    attribute.attnum AS position,
    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type,
    attribute.attnotnull AS "notNull",
    pg_get_expr(default_row.adbin, default_row.adrelid, true) AS "defaultExpression",
    CASE attribute.attidentity
      WHEN 'a' THEN 'always'
      WHEN 'd' THEN 'by_default'
      ELSE 'none'
    END AS identity,
    CASE attribute.attgenerated
      WHEN 's' THEN 'stored'
      ELSE 'none'
    END AS generated
  FROM pg_attribute AS attribute
  INNER JOIN pg_class AS relation ON relation.oid = attribute.attrelid
  INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_attrdef AS default_row
    ON default_row.adrelid = attribute.attrelid
   AND default_row.adnum = attribute.attnum
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
),
index_rows AS (
  SELECT
    table_row.relname AS "tableName",
    index_row.relname AS name,
    index_meta.indisunique AS "unique",
    index_meta.indisprimary AS "primary",
    index_meta.indisvalid AS valid,
    index_meta.indisready AS ready,
    access_method.amname AS "accessMethod",
    COALESCE(
      array_agg(pg_get_indexdef(index_row.oid, position.number, true) ORDER BY position.number)
        FILTER (WHERE position.number <= index_meta.indnkeyatts),
      ARRAY[]::text[]
    ) AS "keyExpressions",
    COALESCE(
      array_agg(pg_get_indexdef(index_row.oid, position.number, true) ORDER BY position.number)
        FILTER (WHERE position.number > index_meta.indnkeyatts),
      ARRAY[]::text[]
    ) AS "includeExpressions",
    pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate,
    pg_get_indexdef(index_row.oid) AS definition
  FROM pg_index AS index_meta
  INNER JOIN pg_class AS index_row ON index_row.oid = index_meta.indexrelid
  INNER JOIN pg_am AS access_method ON access_method.oid = index_row.relam
  INNER JOIN pg_class AS table_row ON table_row.oid = index_meta.indrelid
  INNER JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
  LEFT JOIN LATERAL generate_series(1, index_meta.indnatts) AS position(number) ON true
  WHERE namespace.nspname = 'public'
  GROUP BY table_row.relname, index_row.oid, index_meta.indexrelid,
           index_meta.indisunique, index_meta.indisprimary, index_meta.indisvalid,
           index_meta.indisready, index_meta.indnkeyatts, index_meta.indpred,
           access_method.amname
),
constraint_rows AS (
  SELECT
    table_row.relname AS "tableName",
    constraint_row.conname AS name,
    CASE constraint_row.contype
      WHEN 'c' THEN 'check'
      WHEN 'p' THEN 'primary_key'
      WHEN 'u' THEN 'unique'
      WHEN 'f' THEN 'foreign_key'
      ELSE 'exclusion'
    END AS type,
    COALESCE(local_columns.names, ARRAY[]::text[]) AS columns,
    referenced_namespace.nspname AS "referencedSchema",
    referenced_table.relname AS "referencedTable",
    COALESCE(referenced_columns.names, ARRAY[]::text[]) AS "referencedColumns",
    CASE constraint_row.confmatchtype
      WHEN 'f' THEN 'full'
      WHEN 'p' THEN 'partial'
      WHEN 's' THEN 'simple'
      ELSE NULL
    END AS "matchType",
    CASE constraint_row.confupdtype
      WHEN 'a' THEN 'no_action'
      WHEN 'r' THEN 'restrict'
      WHEN 'c' THEN 'cascade'
      WHEN 'n' THEN 'set_null'
      WHEN 'd' THEN 'set_default'
      ELSE NULL
    END AS "onUpdate",
    CASE constraint_row.confdeltype
      WHEN 'a' THEN 'no_action'
      WHEN 'r' THEN 'restrict'
      WHEN 'c' THEN 'cascade'
      WHEN 'n' THEN 'set_null'
      WHEN 'd' THEN 'set_default'
      ELSE NULL
    END AS "onDelete",
    constraint_row.condeferrable AS deferrable,
    constraint_row.condeferred AS "initiallyDeferred",
    constraint_row.convalidated AS validated,
    pg_get_constraintdef(constraint_row.oid) AS definition
  FROM pg_constraint AS constraint_row
  INNER JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
  INNER JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
  LEFT JOIN pg_class AS referenced_table ON referenced_table.oid = constraint_row.confrelid
  LEFT JOIN pg_namespace AS referenced_namespace
    ON referenced_namespace.oid = referenced_table.relnamespace
  LEFT JOIN LATERAL (
    SELECT array_agg(attribute.attname ORDER BY key.ordinality) AS names
    FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality)
    INNER JOIN pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.conrelid
     AND attribute.attnum = key.attnum
  ) AS local_columns ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(attribute.attname ORDER BY key.ordinality) AS names
    FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, ordinality)
    INNER JOIN pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.confrelid
     AND attribute.attnum = key.attnum
  ) AS referenced_columns ON true
  WHERE namespace.nspname = 'public'
),
policy_rows AS (
  SELECT
    policy.tablename AS "tableName",
    policy.policyname AS name,
    policy.permissive = 'PERMISSIVE' AS permissive,
    policy.roles,
    lower(policy.cmd) AS command,
    policy.qual AS "using",
    policy.with_check AS "withCheck"
  FROM pg_policies AS policy
  WHERE policy.schemaname = 'public'
),
function_rows AS (
  SELECT
    function_row.proname || '(' || pg_catalog.oidvectortypes(function_row.proargtypes) || ')'
      AS identity,
    pg_get_function_result(function_row.oid) AS "resultType",
    language.lanname AS language,
    CASE function_row.provolatile
      WHEN 'i' THEN 'immutable'
      WHEN 's' THEN 'stable'
      ELSE 'volatile'
    END AS volatility,
    function_row.proisstrict AS strict,
    function_row.prosecdef AS "securityDefiner",
    CASE function_row.proparallel
      WHEN 's' THEN 'safe'
      WHEN 'r' THEN 'restricted'
      ELSE 'unsafe'
    END AS parallel,
    function_row.prosrc AS body,
    pg_get_functiondef(function_row.oid) AS definition,
    function_row.proconfig AS config,
    pg_get_userbyid(function_row.proowner) AS owner
  FROM pg_proc AS function_row
  INNER JOIN pg_namespace AS namespace ON namespace.oid = function_row.pronamespace
  INNER JOIN pg_language AS language ON language.oid = function_row.prolang
  WHERE namespace.nspname = 'public'
),
trigger_rows AS (
  SELECT
    table_row.relname || '.' || trigger_row.tgname AS identity,
    table_row.relname AS "tableName",
    trigger_row.tgname AS name,
    CASE trigger_row.tgenabled
      WHEN 'D' THEN 'disabled'
      WHEN 'R' THEN 'replica'
      WHEN 'A' THEN 'always'
      ELSE 'origin'
    END AS enabled,
    CASE WHEN (trigger_row.tgtype & 1) <> 0 THEN 'row' ELSE 'statement' END AS level,
    CASE
      WHEN (trigger_row.tgtype & 2) <> 0 THEN 'before'
      WHEN (trigger_row.tgtype & 64) <> 0 THEN 'instead_of'
      ELSE 'after'
    END AS timing,
    array_remove(ARRAY[
      CASE WHEN (trigger_row.tgtype & 4) <> 0 THEN 'insert' END,
      CASE WHEN (trigger_row.tgtype & 16) <> 0 THEN 'update' END,
      CASE WHEN (trigger_row.tgtype & 8) <> 0 THEN 'delete' END,
      CASE WHEN (trigger_row.tgtype & 32) <> 0 THEN 'truncate' END
    ], NULL)::text[] AS events,
    function_namespace.nspname AS "functionSchema",
    function_row.proname || '(' || pg_catalog.oidvectortypes(function_row.proargtypes) || ')'
      AS "functionIdentity",
    pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid, true) AS "when",
    trigger_row.tgoldtable AS "oldTable",
    trigger_row.tgnewtable AS "newTable",
    constraint_row.oid IS NOT NULL AS "constraint",
    COALESCE(constraint_row.condeferrable, false) AS deferrable,
    COALESCE(constraint_row.condeferred, false) AS "initiallyDeferred",
    pg_get_triggerdef(trigger_row.oid, true) AS definition
  FROM pg_trigger AS trigger_row
  INNER JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
  INNER JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
  INNER JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
  INNER JOIN pg_namespace AS function_namespace ON function_namespace.oid = function_row.pronamespace
  LEFT JOIN pg_constraint AS constraint_row ON constraint_row.oid = trigger_row.tgconstraint
  WHERE namespace.nspname = 'public'
    AND NOT trigger_row.tgisinternal
),
extension_rows AS (
  SELECT extension.extname AS name FROM pg_extension AS extension
),
enum_rows AS (
  SELECT
    enum_type.typname AS name,
    array_agg(enum_value.enumlabel ORDER BY enum_value.enumsortorder) AS values
  FROM pg_type AS enum_type
  INNER JOIN pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
  INNER JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
  WHERE namespace.nspname = 'public'
  GROUP BY enum_type.typname
),
privilege_rows AS (
  SELECT
    object_row.object_type AS "objectType",
    object_row.object_identity AS "objectIdentity",
    grantor_role.rolname AS grantor,
    COALESCE(grantee_role.rolname, 'PUBLIC') AS grantee,
    privilege.privilege_type AS privilege,
    privilege.is_grantable AS grantable
  FROM (
    SELECT 'schema'::text AS object_type, namespace.nspname AS object_identity,
           namespace.nspacl AS acl, namespace.nspowner AS owner
    FROM pg_namespace AS namespace
    WHERE namespace.nspname = 'public'
    UNION ALL
    SELECT
      CASE relation.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END,
      relation.relname,
      relation.relacl,
      relation.relowner
    FROM pg_class AS relation
    INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'S')
    UNION ALL
    SELECT 'function',
           function_row.proname || '(' || pg_catalog.oidvectortypes(function_row.proargtypes) || ')',
           function_row.proacl,
           function_row.proowner
    FROM pg_proc AS function_row
    INNER JOIN pg_namespace AS namespace ON namespace.oid = function_row.pronamespace
    WHERE namespace.nspname = 'public'
  ) AS object_row
  CROSS JOIN LATERAL aclexplode(COALESCE(object_row.acl, acldefault(
    CASE object_row.object_type
      WHEN 'schema' THEN 'n'::"char"
      WHEN 'function' THEN 'f'::"char"
      WHEN 'sequence' THEN 'S'::"char"
      ELSE 'r'::"char"
    END,
    object_row.owner
  ))) AS privilege
  INNER JOIN pg_roles AS grantor_role ON grantor_role.oid = privilege.grantor
  LEFT JOIN pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
),
default_privilege_rows AS (
  SELECT
    owner_role.rolname AS owner,
    namespace.nspname AS schema,
    CASE default_row.defaclobjtype
      WHEN 'f' THEN 'function'
      WHEN 'S' THEN 'sequence'
      ELSE 'table'
    END AS "objectType",
    grantor_role.rolname AS grantor,
    COALESCE(grantee_role.rolname, 'PUBLIC') AS grantee,
    privilege.privilege_type AS privilege,
    privilege.is_grantable AS grantable
  FROM pg_default_acl AS default_row
  INNER JOIN pg_roles AS owner_role ON owner_role.oid = default_row.defaclrole
  LEFT JOIN pg_namespace AS namespace ON namespace.oid = default_row.defaclnamespace
  CROSS JOIN LATERAL aclexplode(default_row.defaclacl) AS privilege
  INNER JOIN pg_roles AS grantor_role ON grantor_role.oid = privilege.grantor
  LEFT JOIN pg_roles AS grantee_role ON grantee_role.oid = privilege.grantee
),
role_rows AS (
  SELECT
    role_row.rolname AS name,
    role_row.rolsuper AS superuser,
    role_row.rolinherit AS inherit,
    role_row.rolcreaterole AS "createRole",
    role_row.rolcreatedb AS "createDb",
    role_row.rolcanlogin AS "canLogin",
    role_row.rolreplication AS replication,
    role_row.rolbypassrls AS "bypassRls"
  FROM pg_roles AS role_row
)
SELECT json_build_object(
  'schemas', COALESCE((SELECT json_agg(schema_rows ORDER BY name) FROM schema_rows), '[]'::json),
  'relations', COALESCE((SELECT json_agg(relation_rows ORDER BY name) FROM relation_rows), '[]'::json),
  'columns', COALESCE((SELECT json_agg(column_rows ORDER BY table_name, position) FROM column_rows), '[]'::json),
  'indexes', COALESCE((SELECT json_agg(index_rows ORDER BY "tableName", name) FROM index_rows), '[]'::json),
  'constraints', COALESCE((SELECT json_agg(constraint_rows ORDER BY "tableName", name) FROM constraint_rows), '[]'::json),
  'policies', COALESCE((SELECT json_agg(policy_rows ORDER BY "tableName", name) FROM policy_rows), '[]'::json),
  'functions', COALESCE((SELECT json_agg(function_rows ORDER BY identity) FROM function_rows), '[]'::json),
  'triggers', COALESCE((SELECT json_agg(trigger_rows ORDER BY identity) FROM trigger_rows), '[]'::json),
  'extensions', COALESCE((SELECT json_agg(extension_rows ORDER BY name) FROM extension_rows), '[]'::json),
  'enums', COALESCE((SELECT json_agg(enum_rows ORDER BY name) FROM enum_rows), '[]'::json),
  'privileges', COALESCE((SELECT json_agg(privilege_rows ORDER BY "objectType", "objectIdentity", grantee, privilege) FROM privilege_rows), '[]'::json),
  'defaultPrivileges', COALESCE((SELECT json_agg(default_privilege_rows ORDER BY owner, schema, "objectType", grantee, privilege) FROM default_privilege_rows), '[]'::json),
  'roles', COALESCE((SELECT json_agg(role_rows ORDER BY name) FROM role_rows), '[]'::json)
) AS snapshot
`;

function normalizeWithProtectedSqlSegments(
  value: string,
  normalizeUnquoted: (masked: string) => string,
): string {
  const protectedSegments: string[] = [];
  let masked = "";

  function protect(segment: string): void {
    const index = protectedSegments.push(segment) - 1;
    // PostgreSQL text values cannot contain NUL, so this marker cannot collide
    // with catalog text or a function body returned by the server.
    masked += `\0${index}\0`;
  }

  for (let index = 0; index < value.length; ) {
    const current = value[index];
    const next = value[index + 1];

    if (current === "-" && next === "-") {
      const end = value.indexOf("\n", index + 2);
      const segmentEnd = end === -1 ? value.length : end;
      protect(value.slice(index, segmentEnd));
      index = segmentEnd;
      continue;
    }

    if (current === "/" && next === "*") {
      let depth = 1;
      let end = index + 2;
      while (end < value.length && depth > 0) {
        if (value[end] === "/" && value[end + 1] === "*") {
          depth += 1;
          end += 2;
        } else if (value[end] === "*" && value[end + 1] === "/") {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      protect(value.slice(index, end));
      index = end;
      continue;
    }

    if (current === "'") {
      const escapeString =
        index > 0 &&
        (value[index - 1] === "E" || value[index - 1] === "e") &&
        (index === 1 || !/[A-Za-z0-9_$]/.test(value[index - 2]));
      let end = index + 1;
      while (end < value.length) {
        if (escapeString && value[end] === "\\") {
          end += Math.min(2, value.length - end);
        } else if (value[end] === "'" && value[end + 1] === "'") {
          end += 2;
        } else if (value[end] === "'") {
          end += 1;
          break;
        } else {
          end += 1;
        }
      }
      protect(value.slice(index, end));
      index = end;
      continue;
    }

    if (current === '"') {
      let end = index + 1;
      while (end < value.length) {
        if (value[end] === '"' && value[end + 1] === '"') {
          end += 2;
        } else if (value[end] === '"') {
          end += 1;
          break;
        } else {
          end += 1;
        }
      }
      protect(value.slice(index, end));
      index = end;
      continue;
    }

    if (current === "$") {
      const delimiter = value.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (delimiter) {
        const closing = value.indexOf(delimiter, index + delimiter.length);
        const end = closing === -1 ? value.length : closing + delimiter.length;
        protect(value.slice(index, end));
        index = end;
        continue;
      }
    }

    masked += current;
    index += 1;
  }

  const normalized = normalizeUnquoted(masked);
  let restored = "";
  let cursor = 0;

  while (cursor < normalized.length) {
    const markerStart = normalized.indexOf("\0", cursor);
    if (markerStart === -1) {
      restored += normalized.slice(cursor);
      break;
    }

    restored += normalized.slice(cursor, markerStart);
    const markerEnd = normalized.indexOf("\0", markerStart + 1);
    if (markerEnd === -1) throw new Error("SQL normalization marker is invalid.");

    const rawIndex = normalized.slice(markerStart + 1, markerEnd);
    if (!/^\d+$/.test(rawIndex)) throw new Error("SQL normalization marker is invalid.");
    const segment = protectedSegments[Number(rawIndex)];
    if (segment === undefined) throw new Error("SQL normalization marker is invalid.");
    restored += segment;
    cursor = markerEnd + 1;
  }

  return restored;
}

export function normalizedSqlWhitespace(value: string): string {
  return normalizeWithProtectedSqlSegments(value, (masked) => masked.trim().replace(/\s+/g, " "));
}

/**
 * PostgreSQL truncates every identifier to NAMEDATALEN-1 = 63 bytes as it creates
 * the object, and warns while doing it ("identifier ... will be truncated to
 * ..."). Catalogs therefore only ever report the truncated name, while Drizzle's
 * naming convention produces foreign keys well past that -- 74 characters for
 * `enterprise_account_members_enterprise_account_id_enterprise_accounts_id_fk`.
 * Looking those up verbatim reports a constraint absent that is demonstrably
 * present, which is what blocked migration 0028.
 *
 * Truncation is by byte, not character, because that is what NAMEDATALEN counts;
 * a multi-byte character straddling the limit is dropped whole rather than split
 * into invalid UTF-8.
 */
export function truncatePgIdentifier(name: string): string {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length <= 63) return name;
  return new TextDecoder("utf8", { fatal: false })
    .decode(bytes.subarray(0, 63))
    .replace(/�+$/u, "");
}

function normalizeWhitespace(value: string): string {
  return normalizeWithProtectedSqlSegments(value, (masked) =>
    masked
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .replace(/\s*,\s*/g, ", "),
  );
}

function normalizeOptionalExpression(value: string | null | undefined): string | null {
  if (value == null) return null;
  let normalized = normalizeWhitespace(value);
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    const inner = normalized.slice(1, -1);
    let depth = 0;
    let balanced = true;
    for (const character of inner) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth < 0) {
        balanced = false;
        break;
      }
    }
    if (!balanced || depth !== 0) break;
    normalized = normalizeWhitespace(inner);
  }
  return normalized;
}

function normalizeConfig(value: readonly string[] | null | undefined): string[] {
  return [...(value ?? [])].map(normalizeWhitespace).sort();
}

function functionSearchPath(config: readonly string[] | null): string[] | undefined {
  const setting = config?.find((entry) => /^search_path\s*=/.test(entry));
  if (!setting) return undefined;
  return setting
    .slice(setting.indexOf("=") + 1)
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""));
}

function observed(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function comparison(
  key: string,
  expectedValue: unknown,
  actualValue: unknown,
  normalize: (value: any) => any = (value) => value,
): VerificationEvidence {
  const expectedNormalized = normalize(expectedValue);
  const actualNormalized = normalize(actualValue);
  return evidence(
    key,
    JSON.stringify(actualNormalized) === JSON.stringify(expectedNormalized),
    observed(expectedNormalized),
    observed(actualNormalized),
  );
}

function presence(key: string, expectedPresent: boolean, actualPresent: boolean) {
  return evidence(
    key,
    actualPresent === expectedPresent,
    expectedPresent ? "present" : "absent",
    actualPresent ? "present" : "absent",
  );
}

function compareDefined<T extends object>(
  keyPrefix: string,
  expectedRow: Partial<T>,
  actualRow: T,
  labels: Partial<Record<keyof T, string>> = {},
  normalizers: Partial<Record<keyof T, (value: any) => unknown>> = {},
): VerificationEvidence[] {
  return (Object.keys(expectedRow) as Array<keyof T>)
    .filter((field) => expectedRow[field] !== undefined)
    .map((field) =>
      comparison(
        `${keyPrefix}:${labels[field] ?? String(field)}`,
        expectedRow[field],
        actualRow[field],
        normalizers[field],
      ),
    );
}

export async function readCatalogSnapshot(query: VerificationQuery): Promise<CatalogSnapshot> {
  const [row] = await query.unsafe<{ snapshot: CatalogRows }>(CATALOG_QUERY);
  if (!row?.snapshot) throw new Error("PostgreSQL catalog snapshot query returned no row.");
  const rows = row.snapshot;
  const relations = new Map<string, RelationRow>(
    rows.relations.map((relation) => [relation.name, { ...relation, columns: [] }]),
  );
  for (const { table_name: tableName, ...column } of rows.columns) {
    const relation = relations.get(tableName);
    if (relation) relation.columns.push(column);
  }

  return {
    schemas: new Map(rows.schemas.map((schema) => [schema.name, schema])),
    relations,
    indexes: new Map(rows.indexes.map((index) => [index.name, index])),
    constraints: new Map(
      rows.constraints.map((constraint) => [
        `${constraint.tableName}.${constraint.name}`,
        constraint,
      ]),
    ),
    policies: new Map(
      rows.policies.map((policy) => [`${policy.tableName}.${policy.name}`, policy]),
    ),
    functions: new Map(rows.functions.map((functionRow) => [functionRow.identity, functionRow])),
    triggers: new Map(rows.triggers.map((trigger) => [trigger.identity, trigger])),
    extensions: new Set(rows.extensions.map((extension) => extension.name)),
    enums: new Map(rows.enums.map((enumRow) => [enumRow.name, enumRow.values])),
    privileges: rows.privileges,
    defaultPrivileges: rows.defaultPrivileges,
    roles: new Map(rows.roles.map((role) => [role.name, role])),
  };
}

export function verifyCatalog(
  snapshot: CatalogSnapshot,
  expected: CatalogExpectation,
): VerificationEvidence[] {
  const checks: VerificationEvidence[] = [];

  for (const schema of expected.schemas ?? []) {
    const actual = snapshot.schemas.get(schema.name);
    const expectedPresent = schema.present ?? true;
    checks.push(presence(`schema:${schema.name}`, expectedPresent, actual !== undefined));
    if (actual && expectedPresent) {
      checks.push(comparison(`schema:${schema.name}:owner`, schema.owner, actual.owner));
    }
  }

  for (const relation of expected.relations ?? []) {
    const actual = snapshot.relations.get(relation.name);
    checks.push(presence(`relation:${relation.name}`, true, actual !== undefined));
    if (!actual) continue;
    checks.push(
      ...compareDefined(
        `relation:${relation.name}`,
        {
          kind: relation.kind,
          owner: relation.owner,
          rls: relation.noRls ? false : relation.rls,
          forceRls: relation.forceRls,
        },
        actual,
        { forceRls: "force-rls" },
      ),
    );
    if (!relation.columns) continue;
    const columns = relation.columns.map((column) =>
      typeof column === "string" ? ({ name: column } satisfies Partial<ColumnExpectation>) : column,
    );
    if (relation.exactColumns) {
      checks.push(
        comparison(
          `relation:${relation.name}:column-order`,
          columns.map((column) => column.name),
          actual.columns.map((column) => column.name),
        ),
      );
    }
    for (const column of columns) {
      const actualColumn = actual.columns.find((candidate) => candidate.name === column.name);
      checks.push(
        presence(`column:${relation.name}.${column.name}`, true, actualColumn !== undefined),
      );
      if (!actualColumn) continue;
      checks.push(
        ...compareDefined(
          `column:${relation.name}.${column.name}`,
          column,
          actualColumn,
          { defaultExpression: "default-expression", notNull: "not-null" },
          { defaultExpression: normalizeOptionalExpression },
        ).filter((check) => !check.key.endsWith(":name")),
      );
    }
  }

  for (const index of expected.indexes ?? []) {
    const actual = snapshot.indexes.get(truncatePgIdentifier(index.name));
    checks.push(presence(`index:${index.name}`, true, actual !== undefined));
    if (!actual) continue;
    checks.push(
      ...compareDefined(
        `index:${index.name}`,
        index,
        actual,
        {
          tableName: "table",
          accessMethod: "access-method",
          keyExpressions: "keys",
          includeExpressions: "include",
        },
        {
          keyExpressions: (value) => (value as string[]).map(normalizeWhitespace),
          includeExpressions: (value) => (value as string[]).map(normalizeWhitespace),
          predicate: normalizeOptionalExpression,
          definition: normalizeWhitespace,
        },
      ).filter((check) => !check.key.endsWith(":name")),
    );
  }

  for (const constraint of expected.constraints ?? []) {
    const identity = `${constraint.tableName}.${constraint.name}`;
    const actual = snapshot.constraints.get(
      `${constraint.tableName}.${truncatePgIdentifier(constraint.name)}`,
    );
    checks.push(presence(`constraint:${identity}`, true, actual !== undefined));
    if (!actual) continue;
    checks.push(
      ...compareDefined(
        `constraint:${identity}`,
        constraint,
        actual,
        {
          referencedSchema: "referenced-schema",
          referencedTable: "referenced-table",
          referencedColumns: "referenced-columns",
          matchType: "match-type",
          onUpdate: "on-update",
          onDelete: "on-delete",
          initiallyDeferred: "initially-deferred",
        },
        { definition: normalizeWhitespace },
      ).filter((check) => !check.key.endsWith(":name") && !check.key.endsWith(":tableName")),
    );
  }

  for (const policy of expected.policies ?? []) {
    const identity = `${policy.tableName}.${policy.name}`;
    const actual = snapshot.policies.get(identity);
    checks.push(presence(`policy:${identity}`, true, actual !== undefined));
    if (!actual) continue;
    checks.push(
      ...compareDefined(
        `policy:${identity}`,
        policy,
        actual,
        { withCheck: "with-check" },
        {
          roles: (value) => [...(value as string[])].sort(),
          command: (value) => String(value).toLowerCase(),
          using: normalizeOptionalExpression,
          withCheck: normalizeOptionalExpression,
        },
      ).filter((check) => !check.key.endsWith(":name") && !check.key.endsWith(":tableName")),
    );
  }

  for (const functionExpectation of expected.functions ?? []) {
    const actual = snapshot.functions.get(functionExpectation.identity);
    checks.push(presence(`function:${functionExpectation.identity}`, true, actual !== undefined));
    if (!actual) continue;
    const { searchPath, ...fields } = functionExpectation;
    checks.push(
      ...compareDefined(
        `function:${functionExpectation.identity}`,
        fields,
        actual,
        { resultType: "result-type", securityDefiner: "security-definer" },
        {
          body: normalizeWhitespace,
          definition: normalizeWhitespace,
        },
      ).filter((check) => !check.key.endsWith(":identity")),
    );
    if (searchPath !== undefined) {
      checks.push(
        comparison(
          `function:${functionExpectation.identity}:search-path`,
          searchPath,
          functionSearchPath(actual.config),
        ),
      );
    }
  }

  for (const trigger of expected.triggers ?? []) {
    const identity = `${trigger.tableName}.${trigger.name}`;
    const actual = snapshot.triggers.get(identity);
    checks.push(presence(`trigger:${identity}`, true, actual !== undefined));
    if (!actual) continue;
    checks.push(
      ...compareDefined(
        `trigger:${identity}`,
        trigger,
        actual,
        {
          functionSchema: "function-schema",
          functionIdentity: "function",
          initiallyDeferred: "initially-deferred",
        },
        {
          events: (value) => [...(value as string[])].sort(),
          when: normalizeOptionalExpression,
          definition: normalizeWhitespace,
        },
      ).filter((check) => !check.key.endsWith(":name") && !check.key.endsWith(":tableName")),
    );
  }

  for (const extension of expected.extensions ?? []) {
    checks.push(presence(`extension:${extension}`, true, snapshot.extensions.has(extension)));
  }

  for (const enumExpectation of expected.enums ?? []) {
    const actual = snapshot.enums.get(enumExpectation.name);
    checks.push(presence(`enum:${enumExpectation.name}`, true, actual !== undefined));
    if (!actual) continue;
    const passes = enumExpectation.exact
      ? JSON.stringify(actual) === JSON.stringify(enumExpectation.values)
      : enumExpectation.values.every((value) => actual.includes(value));
    checks.push(
      evidence(
        `enum:${enumExpectation.name}:values`,
        passes,
        enumExpectation.exact
          ? enumExpectation.values.join(",")
          : `contains ${enumExpectation.values.join(",")}`,
        actual.join(","),
      ),
    );
  }

  for (const privilege of expected.privileges ?? []) {
    const key = `privilege:${privilege.objectType}:${privilege.objectIdentity}:${privilege.grantee}:${privilege.privilege}`;
    const candidates = snapshot.privileges.filter(
      (row) =>
        row.objectType === privilege.objectType &&
        row.objectIdentity === privilege.objectIdentity &&
        row.grantee === privilege.grantee &&
        row.privilege === privilege.privilege &&
        (privilege.grantor === undefined || row.grantor === privilege.grantor),
    );
    const expectedPresent = privilege.present ?? true;
    checks.push(presence(key, expectedPresent, candidates.length > 0));
    if (expectedPresent && candidates.length > 0 && privilege.grantable !== undefined) {
      checks.push(
        comparison(
          `${key}:grantable`,
          privilege.grantable,
          candidates.some((candidate) => candidate.grantable),
        ),
      );
    }
  }

  for (const privilege of expected.defaultPrivileges ?? []) {
    const key = `default-privilege:${privilege.owner}:${privilege.schema ?? "global"}:${privilege.objectType}:${privilege.grantee}:${privilege.privilege}`;
    const candidates = snapshot.defaultPrivileges.filter(
      (row) =>
        row.owner === privilege.owner &&
        row.schema === privilege.schema &&
        row.objectType === privilege.objectType &&
        row.grantee === privilege.grantee &&
        row.privilege === privilege.privilege &&
        (privilege.grantor === undefined || row.grantor === privilege.grantor),
    );
    const expectedPresent = privilege.present ?? true;
    checks.push(presence(key, expectedPresent, candidates.length > 0));
    if (expectedPresent && candidates.length > 0 && privilege.grantable !== undefined) {
      checks.push(
        comparison(
          `${key}:grantable`,
          privilege.grantable,
          candidates.some((candidate) => candidate.grantable),
        ),
      );
    }
  }

  for (const role of expected.roles ?? []) {
    const actual = snapshot.roles.get(role.name);
    const expectedPresent = role.present ?? true;
    checks.push(presence(`role:${role.name}`, expectedPresent, actual !== undefined));
    if (!actual || !expectedPresent) continue;
    checks.push(
      ...compareDefined(`role:${role.name}`, role, actual, {
        createRole: "create-role",
        createDb: "create-db",
        canLogin: "can-login",
        bypassRls: "bypass-rls",
      }).filter((check) => !check.key.endsWith(":name") && !check.key.endsWith(":present")),
    );
  }

  return checks;
}

export function verifyRelations(
  snapshot: CatalogSnapshot,
  expected: readonly RelationExpectation[],
): VerificationEvidence[] {
  return verifyCatalog(snapshot, { relations: expected });
}

export function verifyNamedObjects(
  snapshot: CatalogSnapshot,
  kind: "index" | "constraint" | "policy" | "trigger",
  names: readonly string[],
): VerificationEvidence[] {
  switch (kind) {
    case "index":
      return verifyCatalog(snapshot, {
        indexes: names.map((name) => ({ name })),
      });
    case "constraint":
      return verifyCatalog(snapshot, {
        constraints: names.map((identity) => {
          const separator = identity.indexOf(".");
          return {
            tableName: identity.slice(0, separator),
            name: identity.slice(separator + 1),
          };
        }),
      });
    case "policy":
      return verifyCatalog(snapshot, {
        policies: names.map((identity) => {
          const separator = identity.indexOf(".");
          return {
            tableName: identity.slice(0, separator),
            name: identity.slice(separator + 1),
          };
        }),
      });
    case "trigger":
      return verifyCatalog(snapshot, {
        triggers: names.map((identity) => {
          const separator = identity.indexOf(".");
          return {
            tableName: identity.slice(0, separator),
            name: identity.slice(separator + 1),
          };
        }),
      });
  }
}

export function verifyFunctions(
  snapshot: CatalogSnapshot,
  identities: readonly string[],
  options: { securityDefiner?: boolean; hardenedSearchPath?: boolean } = {},
): VerificationEvidence[] {
  return verifyCatalog(snapshot, {
    functions: identities.map((identity) => ({
      identity,
      securityDefiner: options.securityDefiner,
      searchPath: options.hardenedSearchPath
        ? (["pg_catalog", "public", "pg_temp"] as const)
        : undefined,
    })),
  });
}

export function catalogHasAnyFootprint(
  snapshot: CatalogSnapshot,
  expected: CatalogExpectation,
): boolean {
  return (
    (expected.schemas ?? []).some((item) => snapshot.schemas.has(item.name)) ||
    (expected.relations ?? []).some((item) => snapshot.relations.has(item.name)) ||
    (expected.indexes ?? []).some((item) => snapshot.indexes.has(item.name)) ||
    (expected.constraints ?? []).some((item) =>
      snapshot.constraints.has(`${item.tableName}.${item.name}`),
    ) ||
    (expected.policies ?? []).some((item) =>
      snapshot.policies.has(`${item.tableName}.${item.name}`),
    ) ||
    (expected.functions ?? []).some((item) => snapshot.functions.has(item.identity)) ||
    (expected.triggers ?? []).some((item) =>
      snapshot.triggers.has(`${item.tableName}.${item.name}`),
    ) ||
    (expected.extensions ?? []).some((item) => snapshot.extensions.has(item)) ||
    (expected.enums ?? []).some((item) => snapshot.enums.has(item.name)) ||
    (expected.privileges ?? []).some((item) =>
      snapshot.privileges.some(
        (row) =>
          row.objectType === item.objectType &&
          row.objectIdentity === item.objectIdentity &&
          row.grantee === item.grantee &&
          row.privilege === item.privilege &&
          (item.grantor === undefined || row.grantor === item.grantor),
      ),
    ) ||
    (expected.defaultPrivileges ?? []).some((item) =>
      snapshot.defaultPrivileges.some(
        (row) =>
          row.owner === item.owner &&
          row.schema === item.schema &&
          row.objectType === item.objectType &&
          row.grantee === item.grantee &&
          row.privilege === item.privilege &&
          (item.grantor === undefined || row.grantor === item.grantor),
      ),
    ) ||
    (expected.roles ?? []).some((item) => snapshot.roles.has(item.name))
  );
}

export function normalizedCatalogExpression(value: string | null | undefined): string | null {
  return normalizeOptionalExpression(value);
}

export function normalizedFunctionConfig(value: readonly string[] | null | undefined): string[] {
  return normalizeConfig(value);
}

export function createEmptyCatalogSnapshot(): CatalogSnapshot {
  return {
    schemas: new Map(),
    relations: new Map(),
    indexes: new Map(),
    constraints: new Map(),
    policies: new Map(),
    functions: new Map(),
    triggers: new Map(),
    extensions: new Set(),
    enums: new Map(),
    privileges: [],
    defaultPrivileges: [],
    roles: new Map(),
  };
}
