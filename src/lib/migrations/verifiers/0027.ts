import { readCatalogSnapshot, verifyCatalog, type CatalogExpectation } from "./catalog";
import { column, createdAt, exactTable, idColumn, index, primaryKey } from "./expectations";
import { verifyMigrationSecurity } from "./security";
import { classifyVerification, evidence, type MigrationVerifier } from "./types";

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
      // Key expressions come from the per-column form of pg_get_indexdef, which
      // reports only the expression and never the operator class -- with or
      // without pretty-printing. Asking for "normalized_descriptor gin_trgm_ops"
      // here can never match anything. The operator class is what makes this
      // index worth having, so it is asserted separately against the full
      // definition below rather than dropped.
      index("vendor_aliases_descriptor_trgm_idx", "vendor_aliases", ["normalized_descriptor"], {
        accessMethod: "gin",
      }),
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
    // Trigram search is the entire purpose of this index; a gin index on the same
    // column with the default operator class would satisfy every check above and
    // be useless for the matching this migration exists to enable.
    const trigramDefinition =
      snapshot.indexes.get("vendor_aliases_descriptor_trgm_idx")?.definition ?? "";
    const trigramOperatorClass = evidence(
      "index:vendor_aliases_descriptor_trgm_idx:operator-class",
      /\bgin_trgm_ops\b/.test(trigramDefinition),
      "gin_trgm_ops",
      trigramDefinition || "missing",
    );
    return classifyVerification(
      true,
      [...catalogChecks, ...securityChecks, trigramOperatorClass],
      "0027",
    );
  },
};
