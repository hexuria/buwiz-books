import type { MigrationVerification, VerificationContext, VerificationEvidence } from "../engine";
import {
  catalogHasAnyFootprint,
  readCatalogSnapshot,
  truncatePgIdentifier,
  verifyCatalog,
  type CatalogExpectation,
  type CatalogSnapshot,
  type ColumnExpectation,
  type ConstraintExpectation,
  type IndexExpectation,
  type PolicyExpectation,
  type RelationExpectation,
  type TriggerExpectation,
} from "./catalog";
import { verifyExactPolicyIdentities, verifyMigrationSecurity } from "./security";
import {
  classifyVerification,
  evidence,
  type MigrationVerifier,
  type VerificationQuery,
} from "./types";

export const column = (
  name: string,
  type: string,
  notNull: boolean,
  defaultExpression: string | null = null,
): ColumnExpectation => ({
  name,
  type,
  notNull,
  defaultExpression,
  identity: "none",
  generated: "none",
});

export const idColumn = column("id", "uuid", true, "gen_random_uuid()");
export const createdAt = column("created_at", "timestamp with time zone", true, "now()");
export const updatedAt = column("updated_at", "timestamp with time zone", true, "now()");

export function index(
  name: string,
  tableName: string,
  keyExpressions: readonly string[],
  options: {
    unique?: boolean;
    predicate?: string | null;
    accessMethod?: string;
  } = {},
): IndexExpectation {
  return {
    name,
    tableName,
    unique: options.unique ?? false,
    primary: false,
    valid: true,
    ready: true,
    accessMethod: options.accessMethod ?? "btree",
    keyExpressions: [...keyExpressions],
    includeExpressions: [],
    predicate: options.predicate ?? null,
  };
}

export function constraint(
  tableName: string,
  name: string,
  type: ConstraintExpectation["type"],
  columns: readonly string[],
  options: Partial<ConstraintExpectation> = {},
): ConstraintExpectation {
  return {
    tableName,
    name,
    type,
    columns: [...columns],
    deferrable: false,
    initiallyDeferred: false,
    ...options,
  };
}

export function primaryKey(
  tableName: string,
  columns: readonly string[],
  name = `${tableName}_pkey`,
): ConstraintExpectation {
  return constraint(tableName, name, "primary_key", columns, {
    validated: true,
  });
}

export function foreignKey(
  tableName: string,
  name: string,
  columns: readonly string[],
  referencedTable: string,
  referencedColumns: readonly string[],
  onDelete: ConstraintExpectation["onDelete"] = "no_action",
  options: Partial<ConstraintExpectation> = {},
): ConstraintExpectation {
  return constraint(tableName, name, "foreign_key", columns, {
    referencedSchema: "public",
    referencedTable,
    referencedColumns: [...referencedColumns],
    matchType: "simple",
    onUpdate: "no_action",
    onDelete,
    validated: true,
    ...options,
  });
}

export function check(tableName: string, name: string, definition: string): ConstraintExpectation {
  // Columns are deliberately left undefined rather than empty. pg_constraint
  // records the columns a CHECK references, so asserting `[]` claimed every check
  // constraint touches no column and failed against every real database -- and
  // the definition, which is compared, already pins which columns are involved.
  // compareDefined skips undefined fields, so omitting it drops the check rather
  // than asserting a wrong value.
  const expectation = constraint(tableName, name, "check", [], {
    definition,
    validated: true,
  });
  return { ...expectation, columns: undefined };
}

/**
 * Immutable SQL deliberately installs some constraints with NOT VALID. A later
 * explicit validation is a stronger compatible state, so those expectations
 * intentionally do not constrain pg_constraint.convalidated.
 */
export function installedNotValidConstraint(
  constraintExpectation: ConstraintExpectation,
): ConstraintExpectation {
  const { validated: _validated, ...expectation } = constraintExpectation;
  return expectation;
}

export const localTenantExpression =
  "organization_id = current_setting('app.current_organization_id', true)";
export const permissiveLocalTenantExpression =
  "current_setting('app.current_organization_id', true) = '' OR current_setting('app.current_organization_id', true) IS NULL OR organization_id = current_setting('app.current_organization_id', true)";
export const nullifLocalTenantExpression =
  "NULLIF(current_setting('app.current_organization_id', true), '') IS NULL OR organization_id = NULLIF(current_setting('app.current_organization_id', true), '')";
const finalTenantExpression =
  "current_organization_id() IS NULL OR organization_id = current_organization_id()";

export function tenantPolicy(
  tableName: string,
  name: string,
  expression: string,
): PolicyExpectation {
  return {
    tableName,
    name,
    permissive: true,
    roles: ["public"],
    command: "all",
    using: expression,
    withCheck: expression,
  };
}

export function transitionPolicy(
  snapshot: CatalogSnapshot,
  tableName: string,
  name: string,
  context: VerificationContext,
  localExpression: string,
): PolicyExpectation {
  const identity = `${tableName}.${name}`;
  const final = tenantPolicy(tableName, name, finalTenantExpression);
  const local = tenantPolicy(tableName, name, localExpression);
  if (context.mode === "post_apply") return local;
  if (context.mode === "final") return final;

  const actual = snapshot.policies.get(identity);
  if (
    actual?.using?.includes("current_organization_id()") ||
    actual?.withCheck?.includes("current_organization_id()")
  ) {
    return final;
  }
  return local;
}

function managedRelationNames(expected: CatalogExpectation): string[] {
  return [
    ...(expected.relations ?? []).map((relation) => relation.name),
    ...(expected.indexes ?? []).map((item) => item.tableName),
    ...(expected.constraints ?? []).map((item) => item.tableName),
    ...(expected.policies ?? []).map((policy) => policy.tableName),
    ...(expected.triggers ?? []).map((item) => item.tableName),
  ]
    .filter((name): name is string => name !== undefined)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function policyTableNames(expected: CatalogExpectation): string[] {
  return (expected.policies ?? [])
    .map((policy) => policy.tableName)
    .filter((name, index, names) => names.indexOf(name) === index);
}

export function verifier(
  id: MigrationVerifier["id"],
  expectation: (snapshot: CatalogSnapshot, context: VerificationContext) => CatalogExpectation,
  footprint: (snapshot: CatalogSnapshot) => boolean,
  extra?: (
    query: VerificationQuery,
    snapshot: CatalogSnapshot,
    context: VerificationContext,
  ) => Promise<VerificationEvidence[]>,
  preExecutionBaseline?: (
    query: VerificationQuery,
    snapshot: CatalogSnapshot,
    context: VerificationContext,
  ) => Promise<VerificationEvidence[]>,
): MigrationVerifier {
  return {
    id,
    async verify(query, context) {
      const snapshot = await readCatalogSnapshot(query);
      const expected = expectation(snapshot, context);
      const hasFootprint = footprint(snapshot);
      const catalogChecks = verifyCatalog(snapshot, expected);
      const relationNames = managedRelationNames(expected);
      const securityChecks =
        hasFootprint && relationNames.length > 0
          ? await verifyMigrationSecurity(query, snapshot, relationNames)
          : [];
      const expectedPolicyChecks = hasFootprint
        ? verifyExactPolicyIdentities(
            snapshot,
            id,
            policyTableNames(expected),
            expected.policies ?? [],
          )
        : [];

      if (context.mode === "pre_execution" && preExecutionBaseline) {
        const catalogComplete = [
          ...catalogChecks,
          ...securityChecks,
          ...expectedPolicyChecks,
        ].every((item) => item.status !== "fail");
        const completeChecks = [
          ...catalogChecks,
          ...securityChecks,
          ...expectedPolicyChecks,
          ...(hasFootprint && catalogComplete && extra
            ? await extra(query, snapshot, context)
            : []),
        ];
        if (hasFootprint && completeChecks.every((item) => item.status !== "fail")) {
          return classifyVerification(true, completeChecks, id);
        }

        const baselineChecks = [
          ...securityChecks,
          ...(await preExecutionBaseline(query, snapshot, context)),
        ];
        if (baselineChecks.every((item) => item.status !== "fail")) {
          return {
            state: "absent",
            shape: "schema_sync_baseline",
            evidence: baselineChecks,
          };
        }
        return {
          state: "partial",
          shape: `${id}:partial_schema_sync_baseline`,
          evidence: baselineChecks,
        };
      }

      const checks = [
        ...catalogChecks,
        ...securityChecks,
        ...expectedPolicyChecks,
        ...(hasFootprint && extra ? await extra(query, snapshot, context) : []),
      ];
      return classifyVerification(hasFootprint, checks, id);
    },
  };
}

export function exactTable(
  name: string,
  columns: readonly ColumnExpectation[],
  rls?: boolean,
): RelationExpectation {
  return {
    name,
    kind: "table",
    columns,
    exactColumns: true,
    ...(rls === undefined ? {} : { rls }),
  };
}

export function knownConstraintName(
  snapshot: CatalogSnapshot,
  tableName: string,
  names: readonly string[],
): string {
  // Probed through the same truncation the catalog applies. Without it a name
  // past 63 bytes never matches, and this quietly falls through to the next
  // candidate spelling -- turning a constraint that is present into a different
  // one that is absent.
  return (
    names.find((name) => snapshot.constraints.has(`${tableName}.${truncatePgIdentifier(name)}`)) ??
    names[0]!
  );
}

export function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

export function semanticForeignKeyName(
  snapshot: CatalogSnapshot,
  tableName: string,
  knownNames: readonly string[],
  columns: readonly string[],
  referencedTable: string,
  referencedColumns: readonly string[],
  onDelete: ConstraintExpectation["onDelete"],
): string {
  const candidates = [...snapshot.constraints.values()].filter(
    (candidate) =>
      candidate.tableName === tableName &&
      candidate.type === "foreign_key" &&
      candidate.columns.length === columns.length &&
      candidate.referencedTable === referencedTable &&
      candidate.referencedColumns.length === referencedColumns.length,
  );
  const exact = candidates.find(
    (candidate) =>
      sameColumns(candidate.columns, columns) &&
      sameColumns(candidate.referencedColumns, referencedColumns) &&
      candidate.referencedSchema === "public" &&
      candidate.matchType === "simple" &&
      candidate.onUpdate === "no_action" &&
      candidate.onDelete === onDelete &&
      !candidate.deferrable &&
      !candidate.initiallyDeferred,
  );
  return exact?.name ?? candidates[0]?.name ?? knownConstraintName(snapshot, tableName, knownNames);
}

function schemaSyncExpectation(
  snapshot: CatalogSnapshot,
  expected: CatalogExpectation,
  constraints: readonly ConstraintExpectation[] = expected.constraints ?? [],
): CatalogExpectation {
  return {
    ...expected,
    relations: (expected.relations ?? []).map((relation) =>
      relation.rls === true ? { ...relation, rls: false } : relation,
    ),
    constraints: constraints.map((item) =>
      item.type === "foreign_key" &&
      item.columns !== undefined &&
      item.referencedTable !== undefined &&
      item.referencedTable !== null &&
      item.referencedColumns !== undefined &&
      item.onDelete !== undefined
        ? {
            ...item,
            name: semanticForeignKeyName(
              snapshot,
              item.tableName,
              [item.name],
              item.columns,
              item.referencedTable,
              item.referencedColumns,
              item.onDelete,
            ),
          }
        : item,
    ),
    policies: [],
  };
}

export function schemaSyncBaselineChecks(
  snapshot: CatalogSnapshot,
  expected: CatalogExpectation,
  options: {
    constraints?: readonly ConstraintExpectation[];
    forbidden?: CatalogExpectation;
    key: string;
  },
): VerificationEvidence[] {
  const installedPolicyCount = (expected.policies ?? []).filter((item) =>
    snapshot.policies.has(`${item.tableName}.${item.name}`),
  ).length;
  const forbiddenPresent =
    options.forbidden !== undefined && catalogHasAnyFootprint(snapshot, options.forbidden);
  return [
    ...verifyCatalog(
      snapshot,
      schemaSyncExpectation(snapshot, expected, options.constraints ?? expected.constraints ?? []),
    ),
    evidence(
      `${options.key}:migration-policies-absent`,
      installedPolicyCount === 0,
      "0 migration-owned policies before immutable SQL execution",
      String(installedPolicyCount),
    ),
    ...verifyExactPolicyIdentities(
      snapshot,
      `${options.key}:schema-sync-baseline`,
      policyTableNames(expected),
      [],
    ),
    ...(options.forbidden === undefined
      ? []
      : [
          evidence(
            `${options.key}:migration-footprint-absent`,
            !forbiddenPresent,
            "no migration-owned catalog footprint before immutable SQL execution",
            forbiddenPresent ? "present" : "absent",
          ),
        ]),
  ];
}

export interface ForeignKeyInvariant {
  key: string;
  tableName: string;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  onDelete: ConstraintExpectation["onDelete"];
}

export function verifyForeignKeyInvariants(
  snapshot: CatalogSnapshot,
  invariants: readonly ForeignKeyInvariant[],
): VerificationEvidence[] {
  return invariants.map((invariant) => {
    const matching = [...snapshot.constraints.values()].find(
      (candidate) =>
        candidate.type === "foreign_key" &&
        candidate.tableName === invariant.tableName &&
        JSON.stringify(candidate.columns) === JSON.stringify(invariant.columns) &&
        candidate.referencedSchema === "public" &&
        candidate.referencedTable === invariant.referencedTable &&
        JSON.stringify(candidate.referencedColumns) ===
          JSON.stringify(invariant.referencedColumns) &&
        candidate.matchType === "simple" &&
        candidate.onUpdate === "no_action" &&
        candidate.onDelete === invariant.onDelete &&
        !candidate.deferrable &&
        !candidate.initiallyDeferred &&
        candidate.validated,
    );
    return evidence(
      `foreign-key:${invariant.key}`,
      matching !== undefined,
      `${invariant.tableName}(${invariant.columns.join(",")}) -> ${invariant.referencedTable}(${invariant.referencedColumns.join(",")}) ON DELETE ${invariant.onDelete}`,
      matching?.name ?? "missing or semantically different",
    );
  });
}

export function trigger(
  tableName: string,
  name: string,
  functionIdentity: string,
  events: readonly ("insert" | "update" | "delete" | "truncate")[],
  transitionTables: { oldTable?: string; newTable?: string } = {},
): TriggerExpectation {
  return {
    tableName,
    name,
    enabled: "origin",
    level: "statement",
    timing: "after",
    events: [...events],
    functionSchema: "public",
    functionIdentity,
    when: null,
    oldTable: transitionTables.oldTable ?? null,
    newTable: transitionTables.newTable ?? null,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
  };
}

export function schemaSynchronizedAbsence(
  snapshot: CatalogSnapshot,
  expectation: CatalogExpectation,
  context: VerificationContext,
  additionalEvidence: readonly VerificationEvidence[] = [],
): MigrationVerification {
  const checks = [...verifyCatalog(snapshot, expectation), ...additionalEvidence];
  if (!catalogHasAnyFootprint(snapshot, expectation) && context.mode === "discovery") {
    return { state: "absent", shape: "absent", evidence: [] };
  }
  if (checks.every((item) => item.status !== "fail")) {
    return {
      state: "absent",
      shape: "schema-sync-compatible",
      evidence: checks,
    };
  }
  return {
    state: "partial",
    shape: "schema-sync-drift",
    evidence: checks,
  };
}
