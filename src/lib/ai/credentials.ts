// ============================================================================
// Per-org, per-provider credential resolution.
//
// Transitional by design: Gemini keys still live in
// organization_secrets.geminiApiKeys (the shipped path) and are read from
// there when no credential ROWS exist for the org. New providers only ever
// use rows. That keeps today's orgs working untouched while giving every
// credential a stable row identity going forward.
//
// Decryption reuses crypto.ts; keys never leave this module in plaintext
// except as the value handed straight to an adapter.
// ============================================================================

import { and, eq, isNull } from "drizzle-orm";
import { type DbExecutor } from "../../db";
import { organizationAiCredentials } from "../../db/schema/ai";
import { getOrganizationSecrets } from "../org-secrets";
import { decryptSecret } from "../crypto";
import { credentialFingerprint } from "./provider-health";
import type { AiProvider } from "./errors";
import { createLogger } from "../logger";

const logger = createLogger("ai.credentials");

export interface ResolvedCredential {
  /** Stable identity for health tracking — a hash, never the key. */
  fingerprint: string;
  apiKey: string;
  baseUrl?: string;
  /** Row id when it came from organization_ai_credentials. */
  credentialId?: string;
}

/**
 * Load usable credentials for a provider, newest-usable first.
 * Returns an empty array when the org has none configured.
 */
export async function getOrgCredentials(
  executor: DbExecutor,
  orgId: string,
  provider: AiProvider,
): Promise<ResolvedCredential[]> {
  const rows = await executor
    .select()
    .from(organizationAiCredentials)
    .where(
      and(
        eq(organizationAiCredentials.organizationId, orgId),
        eq(organizationAiCredentials.provider, provider),
        isNull(organizationAiCredentials.revokedAt),
      ),
    );

  if (rows.length > 0) {
    const resolved: ResolvedCredential[] = [];
    for (const row of rows) {
      try {
        const apiKey = decryptSecret(row.encryptedKey);
        if (!apiKey) continue;
        resolved.push({
          fingerprint: credentialFingerprint(apiKey),
          apiKey,
          baseUrl: row.baseUrl ?? undefined,
          credentialId: row.id,
        });
      } catch (err) {
        logger.warn("Skipping undecryptable credential", {
          orgId: orgId.slice(0, 8),
          credentialId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return resolved;
  }

  // Legacy path: Gemini keys still in organization_secrets. Other providers
  // have no legacy home, so they simply have no credentials until added.
  if (provider !== "gemini") return [];

  try {
    const secrets = await getOrganizationSecrets(executor, orgId);
    return secrets.geminiApiKeys
      .map((key) => key.trim())
      .filter(Boolean)
      .map((apiKey) => ({ fingerprint: credentialFingerprint(apiKey), apiKey }));
  } catch (err) {
    logger.error("Failed to load legacy Gemini credentials", {
      orgId: orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** True when the org can actually use this provider (has ≥1 credential). */
export async function hasCredentialsFor(
  executor: DbExecutor,
  orgId: string,
  provider: AiProvider,
): Promise<boolean> {
  const credentials = await getOrgCredentials(executor, orgId, provider);
  return credentials.length > 0;
}
