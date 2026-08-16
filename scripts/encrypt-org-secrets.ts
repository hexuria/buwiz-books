// ============================================================================
// Backfill: encrypt organization_secrets at rest
//
// Encrypts any plaintext values in organization_secrets (geminiApiKeys array
// elements + the resend/stripe/paypal text columns) using src/lib/crypto.ts.
// Idempotent — values already carrying the `enc:v1:` envelope are left alone.
//
// Usage:
//   bun run scripts/encrypt-org-secrets.ts            # encrypt plaintext values
//   bun run scripts/encrypt-org-secrets.ts --dry-run  # report only, no writes
//   bun run scripts/encrypt-org-secrets.ts --rotate   # re-encrypt EVERYTHING
//                                                      # (decrypt-then-encrypt,
//                                                      #  for key rotation)
//
// Rotation flow: set the new key as SECRETS_ENCRYPTION_KEY, move the old key to
// SECRETS_ENCRYPTION_KEY_PREVIOUS, run with --rotate, then unset the previous.
// ============================================================================

import { db } from "../src/db";
import { organization, organizationSecrets } from "../src/db/schema/auth";
import {
  assertEncryptionConfigured,
  decryptSecret,
  encryptSecret,
  isEncrypted,
} from "../src/lib/crypto";
import { sql } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");
const ROTATE = process.argv.includes("--rotate");

/** For a text column value: encrypt plaintext, or (rotate) decrypt+re-encrypt. */
function nextTextValue(value: string | null): { value: string | null; changed: boolean } {
  if (value == null) return { value: null, changed: false };
  if (isEncrypted(value)) {
    if (!ROTATE) return { value, changed: false };
    return { value: encryptSecret(decryptSecret(value)), changed: true };
  }
  return { value: encryptSecret(value), changed: true };
}

async function main() {
  assertEncryptionConfigured();
  console.log(
    `🔐 Encrypting organization_secrets${DRY_RUN ? " (dry run)" : ""}${ROTATE ? " (rotate)" : ""}...\n`,
  );

  const rows = await db
    .select({
      organizationId: organizationSecrets.organizationId,
      geminiApiKeys: organizationSecrets.geminiApiKeys,
      resendApiKey: organizationSecrets.resendApiKey,
      stripeSecretKey: organizationSecrets.stripeSecretKey,
      stripeWebhookSecret: organizationSecrets.stripeWebhookSecret,
      paypalClientSecret: organizationSecrets.paypalClientSecret,
    })
    .from(organizationSecrets);

  let changedRows = 0;
  for (const row of rows) {
    let changed = false;

    const keys = Array.isArray(row.geminiApiKeys) ? row.geminiApiKeys : [];
    const nextKeys = keys.map((key) => {
      if (isEncrypted(key)) {
        if (!ROTATE) return key;
        changed = true;
        return encryptSecret(decryptSecret(key));
      }
      changed = true;
      return encryptSecret(key);
    });

    const resend = nextTextValue(row.resendApiKey);
    const stripeSecret = nextTextValue(row.stripeSecretKey);
    const stripeWebhook = nextTextValue(row.stripeWebhookSecret);
    const paypal = nextTextValue(row.paypalClientSecret);
    changed =
      changed || resend.changed || stripeSecret.changed || stripeWebhook.changed || paypal.changed;

    if (!changed) continue;
    changedRows++;
    console.log(`  • ${row.organizationId} — ${nextKeys.length} key(s) + text columns`);

    if (!DRY_RUN) {
      await db
        .update(organizationSecrets)
        .set({
          geminiApiKeys: nextKeys,
          resendApiKey: resend.value,
          stripeSecretKey: stripeSecret.value,
          stripeWebhookSecret: stripeWebhook.value,
          paypalClientSecret: paypal.value,
          updatedAt: new Date(),
        })
        .where(sql`${organizationSecrets.organizationId} = ${row.organizationId}`);
    }
  }

  // Defense-in-depth: scrub any lingering plaintext keys out of the
  // browser-visible auth_organizations.metadata (migration 0018 should have,
  // but a restored backup or a stale seed may reintroduce them).
  if (!DRY_RUN) {
    await db.execute(
      sql`UPDATE ${organization} SET metadata = (metadata::jsonb - 'geminiApiKeys')::text
          WHERE metadata IS NOT NULL AND metadata::jsonb ? 'geminiApiKeys'`,
    );
  }

  console.log(
    `\n✅ ${DRY_RUN ? "Would update" : "Updated"} ${changedRows} of ${rows.length} secret row(s).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Encryption backfill failed:", error);
    process.exit(1);
  });
