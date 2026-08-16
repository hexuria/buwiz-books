// ============================================================================
// Financial account statement passwords — server-only, encrypted at rest.
//
// Read exclusively through this module; the ciphertext never leaves the server.
// APIs expose only a boolean `statementPasswordSet`.
// ============================================================================

import type { DbExecutor } from "@/db";
import { financialAccountSecrets, financialAccounts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";

/** Deduped cap on how many passwords we brute-try against an emailed PDF. */
const MAX_ORG_PASSWORDS = 10;

/** Decrypted statement password for one account, or null if none is stored. */
export async function getStatementPassword(
  db: DbExecutor,
  financialAccountId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ enc: financialAccountSecrets.statementPasswordEnc })
    .from(financialAccountSecrets)
    .where(eq(financialAccountSecrets.financialAccountId, financialAccountId))
    .limit(1);
  return row ? decryptSecret(row.enc) : null;
}

/** Store (or replace) an account's statement password, encrypted. */
export async function setStatementPassword(
  db: DbExecutor,
  organizationId: string,
  financialAccountId: string,
  password: string,
): Promise<void> {
  const enc = encryptSecret(password);
  await db
    .insert(financialAccountSecrets)
    .values({ financialAccountId, organizationId, statementPasswordEnc: enc })
    .onConflictDoUpdate({
      target: financialAccountSecrets.financialAccountId,
      set: { statementPasswordEnc: enc, updatedAt: new Date() },
    });
}

/** Remove an account's stored statement password. */
export async function clearStatementPassword(
  db: DbExecutor,
  financialAccountId: string,
): Promise<void> {
  await db
    .delete(financialAccountSecrets)
    .where(eq(financialAccountSecrets.financialAccountId, financialAccountId));
}

/**
 * All distinct statement passwords stored for an org's own bank accounts.
 * Used on the inbox path to auto-unlock an emailed statement when no human is
 * present. Capped and deduped to bound the number of decrypt attempts.
 */
export async function listOrgStatementPasswords(
  db: DbExecutor,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ enc: financialAccountSecrets.statementPasswordEnc })
    .from(financialAccountSecrets)
    .where(eq(financialAccountSecrets.organizationId, organizationId))
    .limit(MAX_ORG_PASSWORDS * 3);

  const seen = new Set<string>();
  for (const row of rows) {
    const pw = decryptSecret(row.enc);
    if (pw) seen.add(pw);
    if (seen.size >= MAX_ORG_PASSWORDS) break;
  }
  return [...seen];
}

/** True if the given account (within the org) has a stored statement password. */
export async function hasStatementPassword(
  db: DbExecutor,
  organizationId: string,
  financialAccountId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: financialAccountSecrets.financialAccountId })
    .from(financialAccountSecrets)
    .innerJoin(
      financialAccounts,
      eq(financialAccounts.id, financialAccountSecrets.financialAccountId),
    )
    .where(
      and(
        eq(financialAccountSecrets.financialAccountId, financialAccountId),
        eq(financialAccounts.organizationId, organizationId),
      ),
    )
    .limit(1);
  return !!row;
}
