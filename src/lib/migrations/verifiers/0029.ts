import { readCatalogSnapshot, relationHasColumn, verifyCatalog } from "./catalog";
import { verifyMigrationSecurity } from "./security";
import { schemaSynchronizedAbsence } from "./expectations";
import {
  absentFunctionEvidence,
  assignmentFunction3,
  assignmentFunction4,
  assignmentFunctionContract,
  assignmentFunctionPrivileges,
  classifyPredecessor,
  predecessorSchema0029,
  schema0029,
} from "./business-group-compatibility";
import { verifyFunctionContracts } from "./function-contracts";
import { classifyVerification, evidence, type MigrationVerifier } from "./types";

export const verifier0029: MigrationVerifier = {
  id: "0029",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const fourArguments = context.target.includes("0030");
    const footprint =
      snapshot.functions.has(assignmentFunction3) || snapshot.functions.has(assignmentFunction4);
    const schemaExpectation = schema0029(context.target.includes("0031"));
    if (!footprint) {
      const predecessorChecks = [
        ...verifyCatalog(snapshot, predecessorSchema0029()),
        evidence(
          "0029:account-group-constraint-absent",
          !snapshot.constraints.has(
            "organization_group_entities.organization_group_entities_account_group_fk",
          ),
          "absent",
          snapshot.constraints.has(
            "organization_group_entities.organization_group_entities_account_group_fk",
          )
            ? "present"
            : "absent",
        ),
        evidence(
          "0029:account-unique-constraint-absent",
          !snapshot.constraints.has("organization_groups.organization_groups_account_id_unique"),
          "absent",
          snapshot.constraints.has("organization_groups.organization_groups_account_id_unique")
            ? "present"
            : "absent",
        ),
        evidence(
          "0029:enabled-unique-index-absent",
          !snapshot.indexes.has("organization_group_entities_account_org_enabled_unique"),
          "absent",
          snapshot.indexes.has("organization_group_entities_account_org_enabled_unique")
            ? "present"
            : "absent",
        ),
      ];
      const entity = snapshot.relations.get("organization_group_entities");
      const predecessorFootprint =
        relationHasColumn(entity, "parent_entity_id") ||
        snapshot.indexes.has("organization_group_entities_group_parent_idx") ||
        snapshot.constraints.has(
          "organization_group_entities.organization_group_entities_same_group_parent_fk",
        );
      if (predecessorFootprint) {
        return classifyPredecessor(predecessorChecks);
      }
      return schemaSynchronizedAbsence(snapshot, schema0029(true, true), context);
    }

    const expectedIdentity = fourArguments ? assignmentFunction4 : assignmentFunction3;
    const supersededIdentity = fourArguments ? assignmentFunction3 : assignmentFunction4;
    const expectedContract = assignmentFunctionContract(
      fourArguments,
      context.target.includes("0034"),
    );
    const securityChecks = await verifyMigrationSecurity(
      query,
      snapshot,
      ["organization_group_entities"],
      [expectedContract],
    );
    const checks = [
      ...verifyCatalog(snapshot, {
        ...schemaExpectation,
        privileges: assignmentFunctionPrivileges(snapshot, expectedIdentity),
      }),
      ...verifyFunctionContracts(snapshot, [expectedContract]),
      absentFunctionEvidence(supersededIdentity, snapshot),
      ...securityChecks,
    ];
    return classifyVerification(true, checks, `${expectedIdentity}-prefix`);
  },
};
