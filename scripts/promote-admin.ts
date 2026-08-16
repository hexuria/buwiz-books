#!/usr/bin/env bun
/**
 * promote-admin.ts — Promote a member to admin role via database
 *
 * Usage:
 *   bun scripts/promote-admin.ts <email> [org-name]
 *
 * Examples:
 *   bun scripts/promote-admin.ts admin@company.com
 *   bun scripts/promote-admin.ts admin@company.com "Acme Corp"
 *
 * If org-name is omitted and the user belongs to multiple orgs,
 * you'll be prompted to choose.
 *
 * The "admin" role is privileged and cannot be set via the UI.
 * Only use this script to grant admin access.
 */

import { db } from "../src/db";
import { member, user, organization } from "../src/db/schema/auth";
import { eq } from "drizzle-orm";

const [email, orgName] = process.argv.slice(2);

if (!email) {
  console.error("Usage: bun scripts/promote-admin.ts <email> [org-name]");
  console.error("Example: bun scripts/promote-admin.ts admin@company.com");
  process.exit(1);
}

async function main() {
  // Find user by email
  const [targetUser] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);

  if (!targetUser) {
    console.error(`❌ No user found with email: ${email}`);
    process.exit(1);
  }

  console.log(`✅ Found user: ${targetUser.name ?? targetUser.email} (${targetUser.id})`);

  // Find their memberships
  const memberships = await db
    .select({
      memberId: member.id,
      role: member.role,
      orgId: organization.id,
      orgName: organization.name,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, targetUser.id));

  if (memberships.length === 0) {
    console.error(`❌ User ${email} is not a member of any organization.`);
    process.exit(1);
  }

  // Select org
  let targetMembership;

  if (orgName) {
    targetMembership = memberships.find((m) => m.orgName.toLowerCase() === orgName.toLowerCase());
    if (!targetMembership) {
      console.error(`❌ User is not a member of "${orgName}".`);
      console.error("Available orgs:");
      for (const m of memberships) {
        console.error(`  - ${m.orgName} (role: ${m.role})`);
      }
      process.exit(1);
    }
  } else if (memberships.length === 1) {
    targetMembership = memberships[0];
  } else {
    console.log("\nUser belongs to multiple organizations:");
    for (let i = 0; i < memberships.length; i++) {
      console.log(`  ${i + 1}. ${memberships[i].orgName} (current: ${memberships[i].role})`);
    }
    console.error("\nPlease specify the org name:");
    console.error(`  bun scripts/promote-admin.ts ${email} "OrgName"`);
    process.exit(1);
  }

  // Check current role
  if (targetMembership.role === "admin") {
    console.log(`ℹ️  User is already an admin of "${targetMembership.orgName}".`);
    process.exit(0);
  }

  console.log(`\n📋 Promoting ${email} to admin in "${targetMembership.orgName}"...`);
  console.log(`   Current role: ${targetMembership.role} → admin`);

  // Promote
  await db
    .update(member)
    .set({ role: "admin", updatedAt: new Date() })
    .where(eq(member.id, targetMembership.memberId));

  console.log(`\n✅ Successfully promoted ${email} to admin!`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
