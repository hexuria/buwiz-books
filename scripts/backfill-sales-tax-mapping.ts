// ============================================================================
// Backfill: pin each org's Sales Tax Payable account as an explicit mapping
//
// `resolveTaxPayableAccount` used to find the account by scanning NAMES for
// "%sales tax%" with no ORDER BY. That broke on any rename, also matched
// "Sales Tax Recoverable", and was not deterministic with more than one hit —
// for a tax liability account, a filing-accuracy problem.
//
// It is now driven by the `invoice.sales_tax_payable` mapping, with the name
// match retained as a LAST-resort fallback for one release so existing orgs
// keep crediting the same account they always have. This script writes that
// account into `category_mappings` explicitly, after which the fallback in
// src/lib/invoice-journal.ts and src/routes/api/-invoices.ts can be deleted.
//
// Why not just let the resolver's subtype tier handle it: there is no
// `sales_tax_payable` subtype, so the tier-2 fallback keys on
// `other_current_liabilities` — which would match ANY other-current-liability
// account. Explicit is the only safe answer here.
//
// Idempotent: an org that already has the mapping is left alone. Never
// overwrites a mapping a human set.
//
// Usage:
//   bun run scripts/backfill-sales-tax-mapping.ts            # write mappings
//   bun run scripts/backfill-sales-tax-mapping.ts --dry-run  # report only
// ============================================================================

import { and, asc, eq, ilike } from "drizzle-orm";
import { db, withOrgContext } from "../src/db";
import { accounts } from "../src/db/schema/accounts";
import { organization } from "../src/db/schema/auth";
import { categoryMappings } from "../src/db/schema/category-mappings";

const DRY_RUN = process.argv.includes("--dry-run");

const MAPPING_TYPE = "invoice";
const SOURCE_KEY = "sales_tax_payable";

async function main() {
  const orgs = await db.select({ id: organization.id, name: organization.name }).from(organization);
  console.log(`${DRY_RUN ? "[dry run] " : ""}Scanning ${orgs.length} organization(s)...\n`);

  let written = 0;
  let alreadySet = 0;
  let ambiguous = 0;
  let noAccount = 0;

  for (const org of orgs) {
    await withOrgContext(org.id, "system", "admin", async (tx) => {
      const [existing] = await tx
        .select({ targetCategoryId: categoryMappings.targetCategoryId })
        .from(categoryMappings)
        .where(
          and(
            eq(categoryMappings.organizationId, org.id),
            eq(categoryMappings.mappingType, MAPPING_TYPE),
            eq(categoryMappings.sourceKey, SOURCE_KEY),
          ),
        )
        .limit(1);

      if (existing) {
        alreadySet++;
        return;
      }

      // Exactly the legacy predicate, so we pin what the org has actually been
      // posting to — not what we would choose today.
      const candidates = await tx
        .select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
        .from(accounts)
        .where(
          and(
            eq(accounts.organizationId, org.id),
            eq(accounts.accountType, "liability"),
            ilike(accounts.name, "%sales tax%"),
            eq(accounts.isActive, true),
          ),
        )
        .orderBy(asc(accounts.accountNumber), asc(accounts.id));

      if (candidates.length === 0) {
        noAccount++;
        console.log(`  – ${org.name}: no "%sales tax%" liability account; nothing to pin`);
        return;
      }

      const chosen = candidates[0];
      if (candidates.length > 1) {
        // The legacy resolver used .limit(1) with no ORDER BY, so which of
        // these it picked was not stable. Flag it: a human should confirm.
        ambiguous++;
        console.log(
          `  ! ${org.name}: ${candidates.length} matches (${candidates
            .map((c) => `${c.accountNumber ?? "—"} ${c.name}`)
            .join(" | ")}) — pinning "${chosen.name}", REVIEW THIS`,
        );
      } else {
        console.log(`  ✓ ${org.name}: pinning ${chosen.accountNumber ?? "—"} ${chosen.name}`);
      }

      if (!DRY_RUN) {
        await tx
          .insert(categoryMappings)
          .values({
            organizationId: org.id,
            mappingType: MAPPING_TYPE,
            sourceKey: SOURCE_KEY,
            targetCategoryId: chosen.id,
            updatedAt: new Date(),
          })
          // A concurrent writer or a human who set it between the read and the
          // write wins; we never clobber.
          .onConflictDoNothing({
            target: [
              categoryMappings.organizationId,
              categoryMappings.mappingType,
              categoryMappings.sourceKey,
            ],
          });
      }
      written++;
    });
  }

  console.log(
    `\n${DRY_RUN ? "[dry run] would write" : "wrote"}: ${written}` +
      `\nalready mapped: ${alreadySet}` +
      `\nno matching account: ${noAccount}` +
      `\nambiguous (review): ${ambiguous}`,
  );
  if (ambiguous > 0) {
    console.log(
      "\n⚠️  Ambiguous orgs above had more than one matching account and the old\n" +
        "   resolver's choice was not deterministic. Confirm each before removing\n" +
        "   the name-match fallback.",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Backfill failed:", error);
    process.exit(1);
  });
