import { runtimeRoleNames } from "./security";
import type { CatalogSnapshot, PrivilegeExpectation } from "./catalog";

export function privilegesForExistingRuntimeRoles(
  snapshot: CatalogSnapshot,
  build: (grantee: (typeof runtimeRoleNames)[number]) => PrivilegeExpectation[],
): PrivilegeExpectation[] {
  return runtimeRoleNames.flatMap((grantee) => (snapshot.roles.has(grantee) ? build(grantee) : []));
}

export function requireNonGrantable(
  expectations: readonly PrivilegeExpectation[],
): PrivilegeExpectation[] {
  return expectations.map((expectation) =>
    expectation.present === false ? expectation : { ...expectation, grantable: false },
  );
}

export interface PrivilegeFootprintScope {
  objectType: PrivilegeExpectation["objectType"];
  objectIdentities: readonly string[];
  grantees: readonly string[];
  privileges: readonly string[];
}

export function catalogHasPrivilegeFootprint(
  snapshot: CatalogSnapshot,
  scopes: readonly PrivilegeFootprintScope[],
): boolean {
  return snapshot.privileges.some((row) =>
    scopes.some(
      (scope) =>
        row.objectType === scope.objectType &&
        scope.objectIdentities.includes(row.objectIdentity) &&
        scope.grantees.includes(row.grantee) &&
        scope.privileges.includes(row.privilege),
    ),
  );
}
