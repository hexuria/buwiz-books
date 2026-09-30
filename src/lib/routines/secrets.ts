// ============================================================================
// Routine webhook signing secrets — server-only, encrypted at rest.
//
// Stored with the shared AES-256-GCM envelope (src/lib/crypto.ts,
// SECRETS_ENCRYPTION_KEY) in `routine_secrets`, and referenced from the
// routine by `trigger_config.secret_ref`. The plaintext leaves the server
// exactly once: in the response of the rotate-secret server function.
// ============================================================================

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { routineSecrets } from "@/db/schema/routines";
import { decryptSecret, encryptSecret, isEncrypted } from "@/lib/crypto";

/** 32 random bytes, URL-safe, with a recognizable prefix for secret scanners. */
export function generateRoutineWebhookSecret(): string {
  return `bwz_whsec_${randomBytes(32).toString("base64url")}`;
}

/**
 * Replace the routine's secret. Returns the new row id, which the caller
 * writes to `trigger_config.secret_ref` in the same transaction — so the old
 * secret stops verifying the moment the new one is committed.
 */
export async function replaceRoutineWebhookSecret(
  db: DbExecutor,
  input: { orgId: string; routineId: string; actorId: string | null; secret: string },
): Promise<{ secretRef: string }> {
  await db
    .delete(routineSecrets)
    .where(
      and(
        eq(routineSecrets.organizationId, input.orgId),
        eq(routineSecrets.routineId, input.routineId),
      ),
    );
  const [row] = await db
    .insert(routineSecrets)
    .values({
      organizationId: input.orgId,
      routineId: input.routineId,
      secretEnc: encryptSecret(input.secret),
      createdBy: input.actorId,
    })
    .returning({ id: routineSecrets.id });
  return { secretRef: row.id };
}

/** The decrypted secret a routine's `secret_ref` points at, or null. */
export async function loadRoutineWebhookSecret(
  db: DbExecutor,
  input: { orgId: string; routineId: string; secretRef: string | null },
): Promise<string | null> {
  if (!input.secretRef) return null;
  const [row] = await db
    .select({ secretEnc: routineSecrets.secretEnc })
    .from(routineSecrets)
    .where(
      and(
        eq(routineSecrets.id, input.secretRef),
        eq(routineSecrets.organizationId, input.orgId),
        eq(routineSecrets.routineId, input.routineId),
      ),
    )
    .limit(1);
  if (!row) return null;
  // decryptSecret passes un-enveloped values through for legacy org secrets.
  // Routine secrets have no legacy plaintext, so one here is a defect.
  if (!isEncrypted(row.secretEnc)) {
    throw new Error("Routine webhook secret is not encrypted at rest.");
  }
  return decryptSecret(row.secretEnc);
}
