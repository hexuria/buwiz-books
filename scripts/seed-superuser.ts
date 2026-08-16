import { db } from "../src/db";
import { user, organization, member } from "../src/db/schema/auth";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { updateOrganizationSecrets } from "../src/lib/org-secrets";

/**
 * Seed Superuser Script
 *
 * Creates the initial superuser account and organization.
 * Always recreates data (for use with bun fresh).
 *
 * Usage: bun run scripts/seed-superuser.ts
 */

async function seedSuperuser() {
  console.log("🌱 Seeding superuser...\n");

  // Configuration - update these values as needed
  const SUPERUSER_EMAIL = process.env.SUPERUSER_EMAIL || "ceo@goldcoders.dev";
  const SUPERUSER_NAME = process.env.SUPERUSER_NAME || "System Administrator";
  const ORG_NAME = process.env.ORG_NAME || "Buwiz Platform";
  const ORG_SLUG = process.env.ORG_SLUG || "buwiz-platform";

  try {
    // Clear existing seed data first (fresh = recreate everything)
    console.log("🗑️  Clearing existing seed data...");
    await db.delete(member).where(eq(member.role, "owner"));
    await db.delete(organization).where(eq(organization.slug, ORG_SLUG));
    await db.delete(user).where(eq(user.email, SUPERUSER_EMAIL));

    // Generate IDs
    const userId = randomUUID();
    const orgId = randomUUID();
    const memberId = randomUUID();

    // Create user
    console.log(`📧 Creating user: ${SUPERUSER_EMAIL}`);
    await db.insert(user).values({
      id: userId,
      email: SUPERUSER_EMAIL,
      name: SUPERUSER_NAME,
      emailVerified: true,
    });

    // Create organization
    console.log(`🏢 Creating organization: ${ORG_NAME}`);

    await db.insert(organization).values({
      id: orgId,
      name: ORG_NAME,
      slug: ORG_SLUG,
      metadata: JSON.stringify({}),
    });

    // Credentials must never live in auth_organizations.metadata (Better Auth
    // returns it to browser clients) — store them server-only, encrypted.
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      await updateOrganizationSecrets(db, orgId, { geminiApiKeys: [geminiKey] });
    }

    // Create membership with superuser role
    console.log(`👤 Assigning superuser role...`);
    await db.insert(member).values({
      id: memberId,
      userId: userId,
      organizationId: orgId,
      role: "owner",
    });

    // This seeder deliberately creates exactly ONE member. tests/e2e asserts on
    // member ordering — bills/manual-lifecycle.spec.ts selects an approver with
    // "ArrowDown, Enter" on the assumption that the signed-in user is first in
    // the list — so every extra owner seeded here silently breaks e2e. To sign
    // in locally as somebody else, point SUPERUSER_EMAIL at that address rather
    // than adding a second account.
    console.log("\n✅ Superuser seeded successfully!");
    console.log("─".repeat(40));
    console.log(`   Email:        ${SUPERUSER_EMAIL}`);
    console.log(`   Name:         ${SUPERUSER_NAME}`);
    console.log(`   Organization: ${ORG_NAME}`);
    console.log(`   Role:         owner (superuser)`);
    console.log("─".repeat(40));
    console.log("\n📝 Sign in with Google OAuth using this email.\n");
  } catch (error) {
    console.error("❌ Error seeding superuser:", error);
    process.exit(1);
  }
}

seedSuperuser()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
