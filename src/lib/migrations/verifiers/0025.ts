import type { VerificationContext } from "../engine";
import type { CatalogExpectation, CatalogSnapshot } from "./catalog";
import {
  column,
  createdAt,
  exactTable,
  foreignKey,
  index,
  knownConstraintName,
  primaryKey,
  schemaSyncBaselineChecks,
  updatedAt,
  verifier,
} from "./expectations";

const expectation0025Base: CatalogExpectation = {
  relations: [
    exactTable(
      "financial_account_secrets",
      [
        column("financial_account_id", "uuid", true),
        column("organization_id", "text", true),
        column("statement_password_enc", "text", true),
        createdAt,
        updatedAt,
      ],
      false,
    ),
  ],
  indexes: [
    index("financial_account_secrets_org_idx", "financial_account_secrets", ["organization_id"]),
  ],
  constraints: [
    primaryKey("financial_account_secrets", ["financial_account_id"]),
    foreignKey(
      "financial_account_secrets",
      "financial_account_secrets_financial_account_id_financial_accounts_id_fk",
      ["financial_account_id"],
      "financial_accounts",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "financial_account_secrets",
      "financial_account_secrets_organization_id_auth_organizations_id_fk",
      ["organization_id"],
      "auth_organizations",
      ["id"],
      "cascade",
    ),
  ],
};

function expectation0025(
  snapshot: CatalogSnapshot,
  context: VerificationContext,
): CatalogExpectation {
  const accountForeignKey =
    context.mode === "discovery" || context.mode === "pre_execution"
      ? "financial_account_secrets_financial_account_id_fkey"
      : knownConstraintName(snapshot, "financial_account_secrets", [
          "financial_account_secrets_financial_account_id_financial_accounts_id_fk",
          "financial_account_secrets_financial_account_id_fkey",
        ]);
  const organizationForeignKey =
    context.mode === "discovery" || context.mode === "pre_execution"
      ? "financial_account_secrets_organization_id_fkey"
      : knownConstraintName(snapshot, "financial_account_secrets", [
          "financial_account_secrets_organization_id_auth_organizations_id_fk",
          "financial_account_secrets_organization_id_fkey",
        ]);
  return {
    ...expectation0025Base,
    constraints: (expectation0025Base.constraints ?? []).map((item) => {
      if (item.name === "financial_account_secrets_financial_account_id_financial_accounts_id_fk") {
        return { ...item, name: accountForeignKey };
      }
      if (item.name === "financial_account_secrets_organization_id_auth_organizations_id_fk") {
        return { ...item, name: organizationForeignKey };
      }
      return item;
    }),
  };
}

export const verifier0025 = verifier(
  "0025",
  expectation0025,
  (snapshot) =>
    snapshot.relations.has("financial_account_secrets") ||
    snapshot.indexes.has("financial_account_secrets_org_idx"),
  undefined,
  async (_query, snapshot) => {
    const rawNames = new Set([
      "financial_account_secrets_financial_account_id_fkey",
      "financial_account_secrets_organization_id_fkey",
    ]);
    return schemaSyncBaselineChecks(snapshot, expectation0025Base, {
      key: "0025",
      forbidden: {
        constraints: [...snapshot.constraints.values()].filter((item) => rawNames.has(item.name)),
      },
    });
  },
);
