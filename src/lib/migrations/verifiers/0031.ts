import { readCatalogSnapshot, relationHasColumn, verifyCatalog } from "./catalog";
import { verifyMigrationSecurity } from "./security";
import {
  absentFunctionEvidence,
  assignmentFunction3,
  assignmentFunction4,
  assignmentFunctionContract,
  assignmentFunctionPrivileges,
  classifyPredecessor,
  predecessorSchema0031,
} from "./business-group-compatibility";
import { verifyFunctionContracts } from "./function-contracts";
import { classifyVerification, evidence, type MigrationVerifier } from "./types";

export const verifier0031: MigrationVerifier = {
  id: "0031",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const entity = snapshot.relations.get("organization_group_entities");
    const precedingShape =
      relationHasColumn(entity, "enterprise_account_id") ||
      snapshot.constraints.has(
        "organization_group_entities.organization_group_entities_same_group_parent_fk",
      );
    const parentRemoved = entity !== undefined && !relationHasColumn(entity, "parent_entity_id");
    const removedObjects = [
      "organization_group_entities.organization_group_entities_same_group_parent_fk",
      "organization_group_entities.organization_group_entities_not_own_parent_check",
      "organization_group_entities.organization_group_entities_group_id_id_unique",
    ].every((name) => !snapshot.constraints.has(name));
    const indexRemoved = !snapshot.indexes.has("organization_group_entities_group_parent_idx");
    const anchorIdentity = assignmentFunction4;
    const distinctiveFootprint = snapshot.functions.has(anchorIdentity);
    if (!distinctiveFootprint) {
      const absenceEvidence = [
        evidence(
          "0031:historical-anchor",
          true,
          "0030 assignment function or another parent-object footprint",
          "schema-synchronized flat entity",
        ),
      ];
      const parentFootprint =
        relationHasColumn(entity, "parent_entity_id") ||
        snapshot.indexes.has("organization_group_entities_group_parent_idx") ||
        [
          "organization_group_entities.organization_group_entities_same_group_parent_fk",
          "organization_group_entities.organization_group_entities_not_own_parent_check",
          "organization_group_entities.organization_group_entities_group_id_id_unique",
        ].some((name) => snapshot.constraints.has(name));
      if (!parentFootprint && precedingShape) {
        return {
          state: "absent",
          shape: "schema-sync-compatible",
          evidence: absenceEvidence,
        };
      }
      return classifyVerification(parentFootprint, absenceEvidence, "flat-entities");
    }
    const expectedContract = assignmentFunctionContract(true, context.target.includes("0034"));
    const securityChecks = await verifyMigrationSecurity(
      query,
      snapshot,
      ["organization_group_entities"],
      [expectedContract],
    );
    const predecessorChecks = [
      ...verifyCatalog(snapshot, {
        ...predecessorSchema0031(),
        privileges: assignmentFunctionPrivileges(snapshot, assignmentFunction4),
      }),
      ...verifyFunctionContracts(snapshot, [assignmentFunctionContract(true, false)]),
      absentFunctionEvidence(assignmentFunction3, snapshot),
      ...securityChecks,
    ];
    const predecessorFootprint =
      relationHasColumn(entity, "parent_entity_id") ||
      snapshot.indexes.has("organization_group_entities_group_parent_idx") ||
      [
        "organization_group_entities.organization_group_entities_same_group_parent_fk",
        "organization_group_entities.organization_group_entities_not_own_parent_check",
        "organization_group_entities.organization_group_entities_group_id_id_unique",
      ].some((name) => snapshot.constraints.has(name));
    if (predecessorFootprint) {
      return classifyPredecessor(predecessorChecks);
    }
    return classifyVerification(
      Boolean(precedingShape),
      [
        ...verifyFunctionContracts(snapshot, [expectedContract]),
        absentFunctionEvidence(assignmentFunction3, snapshot),
        ...securityChecks,
        evidence(
          "0031:parent-column-removed",
          parentRemoved,
          "parent_entity_id absent",
          parentRemoved ? "absent" : "present",
        ),
        evidence(
          "0031:parent-constraints-removed",
          removedObjects,
          "all parent constraints absent",
          removedObjects ? "absent" : "present",
        ),
        evidence(
          "0031:parent-index-removed",
          indexRemoved,
          "parent index absent",
          indexRemoved ? "absent" : "present",
        ),
      ],
      "flat-entities",
    );
  },
};
