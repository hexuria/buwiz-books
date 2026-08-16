import { readCatalogSnapshot, verifyCatalog } from "./catalog";
import { verifyMigrationSecurity } from "./security";
import { schemaSynchronizedAbsence } from "./expectations";
import {
  absentFunctionEvidence,
  assignmentFunction3,
  assignmentFunction4,
  assignmentFunctionContract,
  assignmentFunctionPrivileges,
  classifyPredecessor,
  schema0029,
} from "./business-group-compatibility";
import { verifyFunctionContracts } from "./function-contracts";
import { classifyVerification, type MigrationVerifier } from "./types";

export const verifier0030: MigrationVerifier = {
  id: "0030",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const threeArgumentPresent = snapshot.functions.has(assignmentFunction3);
    const fourArgumentPresent = snapshot.functions.has(assignmentFunction4);
    const footprint = threeArgumentPresent || fourArgumentPresent;
    const schemaExpectation = schema0029(context.target.includes("0031"));
    if (!footprint) {
      return schemaSynchronizedAbsence(snapshot, schema0029(true, true), context);
    }
    if (threeArgumentPresent && !fourArgumentPresent) {
      const predecessorContract = assignmentFunctionContract(false, false);
      const securityChecks = await verifyMigrationSecurity(
        query,
        snapshot,
        ["organization_group_entities"],
        [predecessorContract],
      );
      return classifyPredecessor([
        ...verifyCatalog(snapshot, {
          ...schema0029(false),
          privileges: assignmentFunctionPrivileges(snapshot, assignmentFunction3),
        }),
        ...verifyFunctionContracts(snapshot, [predecessorContract]),
        ...securityChecks,
      ]);
    }
    const expectedContract = assignmentFunctionContract(true, context.target.includes("0034"));
    const securityChecks = await verifyMigrationSecurity(
      query,
      snapshot,
      ["organization_group_entities"],
      [expectedContract],
    );
    return classifyVerification(
      footprint,
      [
        ...verifyCatalog(snapshot, {
          ...schemaExpectation,
          privileges: assignmentFunctionPrivileges(snapshot, assignmentFunction4),
        }),
        ...verifyFunctionContracts(snapshot, [expectedContract]),
        absentFunctionEvidence(assignmentFunction3, snapshot),
        ...securityChecks,
      ],
      "four-argument-runtime-probe",
    );
  },
};
