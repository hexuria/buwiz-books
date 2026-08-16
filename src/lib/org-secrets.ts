import type { DbExecutor } from "@/db";
import { organizationSecrets } from "@/db/schema/auth";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";

export type OrganizationSecrets = {
  geminiApiKeys: string[];
  resendApiKey: string | null;
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  paypalClientSecret: string | null;
};

const EMPTY_SECRETS: OrganizationSecrets = {
  geminiApiKeys: [],
  resendApiKey: null,
  stripeSecretKey: null,
  stripeWebhookSecret: null,
  paypalClientSecret: null,
};

export async function getOrganizationSecrets(
  db: DbExecutor,
  organizationId: string,
): Promise<OrganizationSecrets> {
  const [row] = await db
    .select({
      geminiApiKeys: organizationSecrets.geminiApiKeys,
      resendApiKey: organizationSecrets.resendApiKey,
      stripeSecretKey: organizationSecrets.stripeSecretKey,
      stripeWebhookSecret: organizationSecrets.stripeWebhookSecret,
      paypalClientSecret: organizationSecrets.paypalClientSecret,
    })
    .from(organizationSecrets)
    .where(eq(organizationSecrets.organizationId, organizationId))
    .limit(1);
  if (!row) return EMPTY_SECRETS;
  const decryptNullable = (value: string | null): string | null =>
    value == null ? null : decryptSecret(value);
  return {
    geminiApiKeys: Array.isArray(row.geminiApiKeys)
      ? row.geminiApiKeys.map((key) => decryptSecret(key))
      : [],
    resendApiKey: decryptNullable(row.resendApiKey),
    stripeSecretKey: decryptNullable(row.stripeSecretKey),
    stripeWebhookSecret: decryptNullable(row.stripeWebhookSecret),
    paypalClientSecret: decryptNullable(row.paypalClientSecret),
  };
}

/** Encrypt every non-null secret value in a patch before it touches the DB. */
function encryptPatch(patch: Partial<OrganizationSecrets>): Partial<OrganizationSecrets> {
  const out: Partial<OrganizationSecrets> = {};
  if (patch.geminiApiKeys !== undefined) {
    out.geminiApiKeys = patch.geminiApiKeys.map((key) => encryptSecret(key));
  }
  for (const field of [
    "resendApiKey",
    "stripeSecretKey",
    "stripeWebhookSecret",
    "paypalClientSecret",
  ] as const) {
    if (patch[field] !== undefined) {
      out[field] = patch[field] == null ? null : encryptSecret(patch[field]);
    }
  }
  return out;
}

export async function updateOrganizationSecrets(
  db: DbExecutor,
  organizationId: string,
  patch: Partial<OrganizationSecrets>,
): Promise<void> {
  const encrypted = encryptPatch(patch);
  const values = {
    ...EMPTY_SECRETS,
    ...encrypted,
    organizationId,
    updatedAt: new Date(),
  };
  const updateSet = { ...encrypted, updatedAt: new Date() };
  await db.insert(organizationSecrets).values(values).onConflictDoUpdate({
    target: organizationSecrets.organizationId,
    set: updateSet,
  });
}
