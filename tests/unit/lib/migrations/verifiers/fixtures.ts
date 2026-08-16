import type { VerificationContext } from "@/lib/migrations/engine";
import {
  truncatePgIdentifier,
  type CatalogSnapshot,
  type ColumnRow,
} from "@/lib/migrations/verifiers/catalog";
import type { VerificationQuery } from "@/lib/migrations/verifiers/types";

export const context: VerificationContext = {
  mode: "post_apply",
  target: {
    through: "0027",
    includes: () => true,
  },
};

function catalogRows(snapshot: CatalogSnapshot) {
  return {
    schemas: [...snapshot.schemas.values()],
    relations: [...snapshot.relations.values()].map(
      ({ columns: _columns, ...relation }) => relation,
    ),
    columns: [...snapshot.relations.values()].flatMap((relation) =>
      relation.columns.map((item) => ({
        table_name: relation.name,
        ...item,
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

export function queryFor(
  snapshot: CatalogSnapshot,
  data: Record<string, unknown> = {},
): VerificationQuery {
  return {
    async unsafe<T>(sql: string): Promise<T[]> {
      if (sql.includes("pg_attribute") && sql.includes("pg_constraint")) {
        return [{ snapshot: catalogRows(snapshot) }] as T[];
      }
      if (sql.includes("SELECT current_user AS current_user")) {
        return [{ current_user: data.current_user ?? "migration_owner" }] as T[];
      }
      if (sql.includes("pg_available_extensions")) {
        return [{ vector_available: data.vector_available ?? false }] as T[];
      }
      return [data] as T[];
    },
  };
}

export function column(
  name: string,
  type: string,
  notNull: boolean,
  defaultExpression: string | null = null,
  position = 1,
): ColumnRow {
  return {
    name,
    position,
    type,
    notNull,
    defaultExpression,
    identity: "none",
    generated: "none",
  };
}

export function addRelation(
  snapshot: CatalogSnapshot,
  name: string,
  columns: ColumnRow[],
  rls = false,
): void {
  snapshot.relations.set(name, {
    name,
    kind: "table",
    owner: "migration_owner",
    rls,
    forceRls: false,
    columns,
  });
}

export function addIndex(
  snapshot: CatalogSnapshot,
  name: string,
  tableName: string,
  keyExpressions: string[],
  options: {
    unique?: boolean;
    accessMethod?: string;
    predicate?: string | null;
  } = {},
): void {
  // PostgreSQL truncates as it creates, so a fixture must not be able to hold a
  // name the database could never have stored.
  snapshot.indexes.set(truncatePgIdentifier(name), {
    name: truncatePgIdentifier(name),
    tableName,
    unique: options.unique ?? false,
    primary: false,
    valid: true,
    ready: true,
    accessMethod: options.accessMethod ?? "btree",
    keyExpressions,
    includeExpressions: [],
    predicate: options.predicate ?? null,
    definition: `CREATE INDEX ${name}`,
  });
}

export function addPrimaryKey(
  snapshot: CatalogSnapshot,
  tableName: string,
  columns: string[],
): void {
  snapshot.constraints.set(`${tableName}.${tableName}_pkey`, {
    tableName,
    name: `${tableName}_pkey`,
    type: "primary_key",
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
    definition: `PRIMARY KEY (${columns.join(", ")})`,
  });
}

export function addForeignKey(
  snapshot: CatalogSnapshot,
  tableName: string,
  name: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[],
  onDelete: "cascade" | "restrict" | "set_null" | "no_action" = "no_action",
  options: {
    validated?: boolean;
    deferrable?: boolean;
    initiallyDeferred?: boolean;
  } = {},
): void {
  snapshot.constraints.set(`${tableName}.${truncatePgIdentifier(name)}`, {
    tableName,
    name: truncatePgIdentifier(name),
    type: "foreign_key",
    columns,
    referencedSchema: "public",
    referencedTable,
    referencedColumns,
    matchType: "simple",
    onUpdate: "no_action",
    onDelete,
    deferrable: options.deferrable ?? false,
    initiallyDeferred: options.initiallyDeferred ?? false,
    validated: options.validated ?? true,
    definition: `FOREIGN KEY (${columns.join(", ")}) REFERENCES ${referencedTable}`,
  });
}

export function addCheck(
  snapshot: CatalogSnapshot,
  tableName: string,
  name: string,
  definition: string,
  validated = true,
): void {
  snapshot.constraints.set(`${tableName}.${truncatePgIdentifier(name)}`, {
    tableName,
    name: truncatePgIdentifier(name),
    type: "check",
    columns: [],
    referencedSchema: null,
    referencedTable: null,
    referencedColumns: [],
    matchType: null,
    onUpdate: null,
    onDelete: null,
    deferrable: false,
    initiallyDeferred: false,
    validated,
    definition,
  });
}

export function addPolicy(
  snapshot: CatalogSnapshot,
  tableName: string,
  name: string,
  expression: string,
): void {
  snapshot.policies.set(`${tableName}.${name}`, {
    tableName,
    name,
    permissive: true,
    roles: ["public"],
    command: "all",
    using: expression,
    withCheck: expression,
  });
}

export function withContext(
  mode: VerificationContext["mode"],
  included: string[],
): VerificationContext {
  return {
    mode,
    target: {
      through: included.at(-1)! as VerificationContext["target"]["through"],
      includes: (id) => included.includes(id),
    },
  };
}
