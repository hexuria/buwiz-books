import {
  catalogHasAnyFootprint,
  readCatalogSnapshot,
  verifyCatalog,
  type CatalogExpectation,
  type CatalogSnapshot,
  type PrivilegeExpectation,
} from "./catalog";
import { runtimeRoleNames, verifyExactPolicyIdentities, verifyMigrationSecurity } from "./security";
import { schemaSynchronizedAbsence } from "./expectations";
import {
  catalogHasPrivilegeFootprint,
  privilegesForExistingRuntimeRoles,
  requireNonGrantable,
  type PrivilegeFootprintScope,
} from "./acl-expectations";
import {
  contracts0028,
  functions0028,
  policies0028,
  policyExpectations0028,
  schema0028,
  schema0028AtTarget,
} from "./business-group-compatibility";
import { verifyFunctionContracts } from "./function-contracts";
import { classifyVerification, type MigrationVerifier } from "./types";

const runtimeTables0028 = [
  "enterprise_accounts",
  "enterprise_account_members",
  "account_entitlements",
  "entitlement_events",
  "organization_groups",
  "organization_group_members",
  "organization_group_entities",
  "organization_group_audit_events",
] as const;

const privilegeFootprintScopes0028: readonly PrivilegeFootprintScope[] = [
  {
    objectType: "table",
    objectIdentities: runtimeTables0028,
    grantees: runtimeRoleNames,
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  },
  {
    objectType: "function",
    objectIdentities: functions0028,
    grantees: runtimeRoleNames,
    privileges: ["EXECUTE"],
  },
];

function privileges0028(snapshot: CatalogSnapshot, hardened: boolean): PrivilegeExpectation[] {
  return requireNonGrantable(
    privilegesForExistingRuntimeRoles(snapshot, (grantee) => [
      ...runtimeTables0028.flatMap((objectIdentity) => {
        const privileges =
          hardened &&
          (objectIdentity === "entitlement_events" ||
            objectIdentity === "organization_group_audit_events")
            ? ["SELECT"]
            : ["SELECT", "INSERT", "UPDATE", "DELETE"];
        return privileges.map((privilege) => ({
          objectType: "table" as const,
          objectIdentity,
          grantee,
          privilege,
        }));
      }),
      ...functions0028.map((objectIdentity) => ({
        objectType: "function" as const,
        objectIdentity,
        grantee,
        privilege: "EXECUTE",
      })),
    ]),
  );
}

const footprint0028: CatalogExpectation = {
  functions: functions0028.map((identity) => ({ identity })),
  policies: policies0028.map((identity) => {
    const separator = identity.indexOf(".");
    return {
      tableName: identity.slice(0, separator),
      name: identity.slice(separator + 1),
    };
  }),
};

export const verifier0028: MigrationVerifier = {
  id: "0028",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const footprint =
      catalogHasAnyFootprint(snapshot, footprint0028) ||
      catalogHasPrivilegeFootprint(snapshot, privilegeFootprintScopes0028);
    if (!footprint) return schemaSynchronizedAbsence(snapshot, schema0028, context);

    const hardened = context.target.includes("0034");
    const historicalSchema = schema0028AtTarget({
      exclusivity: context.target.includes("0029"),
      flatEntities: context.target.includes("0031"),
      adminGuards: hardened,
    });
    const expectedContracts = contracts0028(hardened);
    const securityChecks = await verifyMigrationSecurity(
      query,
      snapshot,
      runtimeTables0028,
      expectedContracts,
    );
    const checks = [
      ...verifyCatalog(snapshot, {
        ...historicalSchema,
        relations: historicalSchema.relations?.map((relation) => ({
          ...relation,
          rls: true,
        })),
        policies: policyExpectations0028(hardened),
        privileges: privileges0028(snapshot, hardened),
      }),
      ...verifyFunctionContracts(snapshot, expectedContracts),
      ...verifyExactPolicyIdentities(
        snapshot,
        "0028",
        runtimeTables0028,
        policyExpectations0028(hardened),
      ),
      ...securityChecks,
    ];
    return classifyVerification(true, checks, "enterprise-business-groups");
  },
};
