import { readCatalogSnapshot, verifyCatalog, type CatalogExpectation } from "./catalog";
import { column, createdAt, exactTable, idColumn, index, primaryKey } from "./expectations";
import { verifyMigrationSecurity } from "./security";
import { classifyVerification, type MigrationVerifier } from "./types";

function expectation0027(vectorAvailable: boolean): CatalogExpectation {
  return {
    relations: [
      exactTable("vendor_aliases", [
        idColumn,
        column("organization_id", "text", true),
        column("normalized_descriptor", "text", true),
        column("party_id", "uuid", true),
        column("source", "text", true),
        createdAt,
        ...(vectorAvailable ? [column("embedding", "halfvec(768)", false)] : []),
      ]),
    ],
    indexes: [
      index(
        "vendor_aliases_org_descriptor_unique",
        "vendor_aliases",
        ["organization_id", "normalized_descriptor"],
        { unique: true },
      ),
      index(
        "vendor_aliases_descriptor_trgm_idx",
        "vendor_aliases",
        ["normalized_descriptor gin_trgm_ops"],
        { accessMethod: "gin" },
      ),
    ],
    constraints: [primaryKey("vendor_aliases", ["id"])],
    extensions: ["pg_trgm", ...(vectorAvailable ? ["vector"] : [])],
  };
}

export const verifier0027: MigrationVerifier = {
  id: "0027",
  async verify(query, _context) {
    const snapshot = await readCatalogSnapshot(query);
    const footprint =
      snapshot.relations.has("vendor_aliases") ||
      snapshot.indexes.has("vendor_aliases_org_descriptor_unique") ||
      snapshot.indexes.has("vendor_aliases_descriptor_trgm_idx");
    const vectorInstalled = snapshot.extensions.has("vector");
    const expected = expectation0027(vectorInstalled);
    const catalogChecks = verifyCatalog(snapshot, expected);
    if (!footprint) return classifyVerification(false, catalogChecks, "0027");
    const securityChecks = await verifyMigrationSecurity(query, snapshot, ["vendor_aliases"]);
    return classifyVerification(true, [...catalogChecks, ...securityChecks], "0027");
  },
};
