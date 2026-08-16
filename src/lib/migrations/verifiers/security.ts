import type { VerificationEvidence } from "../engine";
import type { CatalogSnapshot, PolicyExpectation } from "./catalog";
import { evidence, type VerificationQuery } from "./types";

export const runtimeRoleNames = ["app_runtime", "buwiz_app"] as const;

export interface MigrationSecurityFunctionContract {
  identity: string;
  securityDefiner?: boolean;
}

async function readMigrationPrincipal(query: VerificationQuery): Promise<string | null> {
  const [row] = await query.unsafe<{ current_user: string }>("SELECT current_user AS current_user");
  const principal = row?.current_user?.trim();
  return principal ? principal : null;
}

function verifyMigrationPrincipal(principal: string | null): VerificationEvidence[] {
  return [
    evidence(
      "migration-principal:privileged-role",
      principal !== null && !runtimeRoleNames.some((runtimeRole) => runtimeRole === principal),
      "a non-runtime migration principal",
      principal ?? "missing",
    ),
  ];
}

function verifyMigrationOwnership(
  snapshot: CatalogSnapshot,
  principal: string | null,
  relationNames: readonly string[],
  functionContracts: readonly MigrationSecurityFunctionContract[] = [],
): VerificationEvidence[] {
  const expectedOwner = principal ?? "active migration principal";

  return [
    ...relationNames.map((relationName) => {
      const owner = snapshot.relations.get(relationName)?.owner;
      return evidence(
        `migration-owner:relation:${relationName}`,
        principal !== null && owner === principal,
        expectedOwner,
        owner ?? "missing",
      );
    }),
    ...functionContracts
      .filter((contract) => contract.securityDefiner === true)
      .map((contract) => {
        const owner = snapshot.functions.get(contract.identity)?.owner;
        return evidence(
          `migration-owner:function:${contract.identity}`,
          principal !== null && owner === principal,
          expectedOwner,
          owner ?? "missing",
        );
      }),
  ];
}

function verifyRuntimeRoleSafety(snapshot: CatalogSnapshot): VerificationEvidence[] {
  return runtimeRoleNames.flatMap((roleName) => {
    const role = snapshot.roles.get(roleName);
    if (!role) return [];

    return [
      evidence(
        `runtime-role:${roleName}:bypass-rls`,
        role.bypassRls === false,
        "false",
        String(role.bypassRls),
      ),
    ];
  });
}

export async function verifyMigrationSecurity(
  query: VerificationQuery,
  snapshot: CatalogSnapshot,
  relationNames: readonly string[],
  functionContracts: readonly MigrationSecurityFunctionContract[] = [],
): Promise<VerificationEvidence[]> {
  const principal = await readMigrationPrincipal(query);

  return [
    ...verifyMigrationPrincipal(principal),
    ...verifyMigrationOwnership(snapshot, principal, relationNames, functionContracts),
    ...verifyRuntimeRoleSafety(snapshot),
  ];
}

export function verifyExactPolicyIdentities(
  snapshot: CatalogSnapshot,
  key: string,
  tableNames: readonly string[],
  expectedPolicies: readonly PolicyExpectation[],
): VerificationEvidence[] {
  const tables = new Set(tableNames);
  const expected = expectedPolicies.map((policy) => `${policy.tableName}.${policy.name}`).sort();
  const actual = [...snapshot.policies.values()]
    .filter((policy) => tables.has(policy.tableName))
    .map((policy) => `${policy.tableName}.${policy.name}`)
    .sort();

  return [
    evidence(
      `${key}:exact-policy-identities`,
      JSON.stringify(actual) === JSON.stringify(expected),
      expected.join(", ") || "no policies",
      actual.join(", ") || "no policies",
    ),
  ];
}
