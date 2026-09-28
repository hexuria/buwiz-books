/**
 * The per-organization `inbox_v2` rollout flag (spec §11).
 *
 * Stored in the organization's metadata, not an env var, so the old and new Inbox can coexist
 * org by org — both read the same tables, so open items carry over either way. Absent means off.
 */
import { eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { organization } from "@/db/schema/auth";
import { parseOrgMetadata, type OrgMetadata } from "@/lib/org-metadata";

export function isInboxV2Enabled(metadata: Pick<OrgMetadata, "inboxV2">): boolean {
  return metadata.inboxV2 === true;
}

export async function readInboxV2Enabled(db: DbExecutor, orgId: string): Promise<boolean> {
  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return isInboxV2Enabled(parseOrgMetadata(org?.metadata));
}

function metadataObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Flip the flag. Merges into the stored JSON rather than re-serializing the parsed schema, so a
 * key this build does not know about survives; the row lock keeps a concurrent metadata write
 * from being lost between the read and the update.
 */
export async function setInboxV2Enabled(
  db: DbExecutor,
  orgId: string,
  enabled: boolean,
): Promise<void> {
  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .for("update")
    .limit(1);
  if (!org) throw new Error("Organization not found");

  await db
    .update(organization)
    .set({
      metadata: JSON.stringify({ ...metadataObject(org.metadata), inboxV2: enabled }),
      updatedAt: new Date(),
    })
    .where(eq(organization.id, orgId));
}
