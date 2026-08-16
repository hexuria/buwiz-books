import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MigrationId } from "@/lib/migrations/manifest";
import {
  createEmptyCatalogSnapshot,
  truncatePgIdentifier,
  type CatalogSnapshot,
  type ColumnExpectation,
  type ConstraintRow,
  type FunctionRow,
  type PolicyRow,
  type PrivilegeRow,
  type TriggerRow,
} from "@/lib/migrations/verifiers/catalog";
import type { VerificationQuery } from "@/lib/migrations/verifiers/types";

const column = (
  name: string,
  position: number,
  type = "text",
  notNull = true,
  defaultExpression: string | null = null,
) => ({
  name,
  position,
  type,
  notNull,
  defaultExpression,
  identity: "none" as const,
  generated: "none" as const,
});

function context(
  through: MigrationId,
  mode: "discovery" | "pre_execution" | "post_apply" | "final" = "discovery",
) {
  return {
    mode,
    target: {
      through,
      includes: (id: MigrationId) => id <= through,
    },
  };
}

function serializedSnapshot(snapshot: CatalogSnapshot) {
  return {
    schemas: [...snapshot.schemas.values()],
    relations: [...snapshot.relations.values()].map(
      ({ columns: _columns, ...relation }) => relation,
    ),
    columns: [...snapshot.relations.values()].flatMap((relation) =>
      relation.columns.map((entry) => ({
        ...entry,
        table_name: relation.name,
      })),
    ),
    indexes: [...snapshot.indexes.values()],
    constraints: [...snapshot.constraints.values()],
    policies: [...snapshot.policies.values()],
    functions: [...snapshot.functions.values()],
    triggers: [...snapshot.triggers.values()],
    extensions: [...snapshot.extensions].map((name) => ({ name })),
    enums: [...snapshot.enums].map(([name, values]) => ({ name, values })),
    privileges: snapshot.privileges,
    defaultPrivileges: snapshot.defaultPrivileges,
    roles: [...snapshot.roles.values()],
  };
}

function queryFor(
  snapshot = createEmptyCatalogSnapshot(),
  taggedRows: unknown[] = [],
  activePrincipal = "migration_owner",
) {
  let catalogRead = false;
  const query: VerificationQuery = {
    async unsafe<T>(sql: string): Promise<T[]> {
      if (/\bSELECT\s+current_user\s+AS\s+current_user\b/i.test(sql)) {
        return [{ current_user: activePrincipal }] as T[];
      }
      if (!catalogRead) {
        catalogRead = true;
        return [{ snapshot: serializedSnapshot(snapshot) }] as T[];
      }
      return taggedRows as T[];
    },
  };
  return {
    snapshot,
    query,
  };
}

function addSchemaTable(
  snapshot: CatalogSnapshot,
  name: string,
  columns: readonly ColumnExpectation[],
) {
  snapshot.relations.set(name, {
    name,
    kind: "table",
    owner: "migration_owner",
    rls: false,
    forceRls: false,
    columns: columns.map((entry, index) => ({
      ...entry,
      position: entry.position ?? index + 1,
    })),
  });
}

function addIndex(
  snapshot: CatalogSnapshot,
  name: string,
  tableName: string,
  keyExpressions: string[],
  options: { unique?: boolean; predicate?: string | null } = {},
) {
  // PostgreSQL truncates identifiers to 63 bytes as it creates them and keeps no
  // memory of the longer name, so neither the key nor the row may hold one.
  snapshot.indexes.set(truncatePgIdentifier(name), {
    name: truncatePgIdentifier(name),
    tableName,
    unique: options.unique ?? false,
    primary: false,
    valid: true,
    ready: true,
    accessMethod: "btree",
    keyExpressions,
    includeExpressions: [],
    predicate: options.predicate ?? null,
    definition: `CREATE INDEX ${name}`,
  });
}

function addConstraint(
  snapshot: CatalogSnapshot,
  tableName: string,
  name: string,
  type: ConstraintRow["type"],
  columns: string[],
  options: Partial<ConstraintRow> = {},
) {
  snapshot.constraints.set(`${tableName}.${truncatePgIdentifier(name)}`, {
    tableName,
    name: truncatePgIdentifier(name),
    type,
    columns,
    referencedSchema: null,
    referencedTable: null,
    referencedColumns: [],
    matchType: null,
    onUpdate: null,
    onDelete: null,
    deferrable: false,
    initiallyDeferred: false,
    validated: true,
    definition: `${type} (${columns.join(", ")})`,
    ...options,
  });
}

function addPrimaryKey(snapshot: CatalogSnapshot, tableName: string, columns = ["id"]) {
  addConstraint(snapshot, tableName, `${tableName}_pkey`, "primary_key", columns);
}

function addForeignKey(
  snapshot: CatalogSnapshot,
  tableName: string,
  name: string,
  columns: string[],
  referencedTable: string,
  referencedColumns = ["id"],
  onDelete: ConstraintRow["onDelete"] = "no_action",
) {
  addConstraint(snapshot, tableName, name, "foreign_key", columns, {
    referencedSchema: "public",
    referencedTable,
    referencedColumns,
    matchType: "simple",
    onUpdate: "no_action",
    onDelete,
  });
}

function addCheck(snapshot: CatalogSnapshot, tableName: string, name: string, definition: string) {
  addConstraint(snapshot, tableName, name, "check", [], { definition });
}

function addFunction(
  snapshot: CatalogSnapshot,
  identity: string,
  body: string,
  options: Partial<FunctionRow> = {},
) {
  snapshot.functions.set(identity, {
    identity,
    resultType: "boolean",
    language: "sql",
    volatility: "stable",
    strict: false,
    securityDefiner: true,
    parallel: "unsafe",
    body,
    definition: `CREATE FUNCTION ${identity}`,
    config: ["search_path=public"],
    owner: "migration_owner",
    ...options,
  });
}

function addPolicy(
  snapshot: CatalogSnapshot,
  tableName: string,
  name: string,
  options: Partial<PolicyRow> = {},
) {
  snapshot.policies.set(`${tableName}.${name}`, {
    tableName,
    name,
    permissive: true,
    roles: ["public"],
    command: "select",
    using: null,
    withCheck: null,
    ...options,
  });
}

function addTrigger(
  snapshot: CatalogSnapshot,
  tableName: string,
  name: string,
  functionIdentity: string,
  events: TriggerRow["events"],
  options: Partial<TriggerRow> = {},
) {
  snapshot.triggers.set(`${tableName}.${name}`, {
    identity: `${tableName}.${name}`,
    tableName,
    name,
    enabled: "origin",
    level: "statement",
    timing: "after",
    events,
    functionSchema: "public",
    functionIdentity,
    when: null,
    oldTable: null,
    newTable: null,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
    definition: `CREATE TRIGGER ${name}`,
    ...options,
  });
}

function addPrivilege(
  snapshot: CatalogSnapshot,
  objectType: PrivilegeRow["objectType"],
  objectIdentity: string,
  grantee: string,
  privilege: string,
) {
  snapshot.privileges.push({
    objectType,
    objectIdentity,
    grantor: "migration_owner",
    grantee,
    privilege,
    grantable: false,
  });
}

function addRole(snapshot: CatalogSnapshot, name: string) {
  snapshot.roles.set(name, {
    name,
    superuser: false,
    inherit: true,
    createRole: false,
    createDb: false,
    canLogin: true,
    replication: false,
    bypassRls: false,
  });
}

const migrationSql = (fileName: string) => readFileSync(resolve("drizzle", fileName), "utf8");

function migrationFunctionBody(sql: string, functionName: string) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = sql.search(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION\\s+${escaped}\\s*\\(`, "i"));
  if (start < 0) throw new Error(`Missing ${functionName} in migration fixture`);
  const match = sql.slice(start).match(/\bAS\s+\$\$([\s\S]*?)\$\$;/i);
  if (!match) throw new Error(`Missing body for ${functionName} in migration fixture`);
  return match[1];
}

export {
  addCheck,
  addConstraint,
  addForeignKey,
  addFunction,
  addIndex,
  addPolicy,
  addPrimaryKey,
  addPrivilege,
  addRole,
  addSchemaTable,
  addTrigger,
  column,
  context,
  createEmptyCatalogSnapshot,
  migrationFunctionBody,
  migrationSql,
  queryFor,
};
