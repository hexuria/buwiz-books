/**
 * Financial Account Secrets (server-only)
 *
 * Per-bank-account statement PDF passwords, encrypted at rest via
 * src/lib/crypto.ts. Like organization_secrets, this table has NO row-level
 * security policy — it is read exclusively through server-side code and its
 * ciphertext is never returned to clients (APIs expose only a boolean
 * `statementPasswordSet`).
 */
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { financialAccounts } from "./financial-accounts";

export const financialAccountSecrets = pgTable("financial_account_secrets", {
  financialAccountId: uuid("financial_account_id")
    .primaryKey()
    .references(() => financialAccounts.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  statementPasswordEnc: text("statement_password_enc").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
