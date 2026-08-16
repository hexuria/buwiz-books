/**
 * Seed Documents — Insert sample documents into the database
 * Usage: bun run scripts/seed-documents.ts
 */
import { db } from "../src/db";
import { documents } from "../src/db/schema/documents";

async function main() {
  console.log("🗂  Seeding documents...");

  // Default org — update this to your actual org ID
  const orgId =
    process.env.ORG_ID ||
    (
      await db
        .select({ id: documents.organizationId })
        .from(documents)
        .limit(1)
        .catch(() => [])
    )[0]?.id;

  if (!orgId) {
    // Try to get org from the organizations table
    const { sql } = await import("drizzle-orm");
    const result = await db.execute(sql`SELECT id FROM organization LIMIT 1`);
    const fallbackOrgId = (result as any)?.[0]?.id;
    if (!fallbackOrgId) {
      console.error("❌ No organization found. Set ORG_ID env var or create an org first.");
      process.exit(1);
    }
    await seedDocuments(fallbackOrgId);
    return;
  }

  await seedDocuments(orgId);
}

async function seedDocuments(orgId: string) {
  const sampleDocuments = [
    {
      organizationId: orgId,
      originalFilename: "Q4-2025-Bank-Statement.pdf",
      displayTitle: "Q4 2025 Bank Statement",
      summary:
        "Quarterly bank statement from First National Bank covering October through December 2025.",
      documentType: "statement" as const,
      fileType: "pdf" as const,
      storagePath: "local://documents/q4-2025-bank-statement.pdf",
      fileSizeBytes: 245_760,
      mimeType: "application/pdf",
    },
    {
      organizationId: orgId,
      originalFilename: "Office-Supplies-Receipt-Jan2026.jpg",
      displayTitle: "Office Supplies Receipt",
      summary: "Receipt from Staples for printer paper, toner cartridges, and desk organizers.",
      documentType: "receipt" as const,
      fileType: "jpg" as const,
      storagePath: "local://documents/office-supplies-receipt.jpg",
      fileSizeBytes: 1_048_576,
      mimeType: "image/jpeg",
    },
    {
      organizationId: orgId,
      originalFilename: "Vendor-Contract-CloudServices-2026.pdf",
      displayTitle: "Cloud Services Agreement",
      summary: "Annual service agreement with AWS for cloud hosting and compute resources.",
      documentType: "contract" as const,
      fileType: "pdf" as const,
      storagePath: "local://documents/vendor-contract-cloud-2026.pdf",
      fileSizeBytes: 512_000,
      mimeType: "application/pdf",
    },
    {
      organizationId: orgId,
      originalFilename: "2025-Annual-Revenue-Report.xlsx",
      displayTitle: "2025 Annual Revenue Report",
      summary:
        "Comprehensive revenue breakdown by product line and geography for fiscal year 2025.",
      documentType: "other" as const,
      fileType: "xlsx" as const,
      storagePath: "local://documents/2025-annual-revenue.xlsx",
      fileSizeBytes: 3_145_728,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      organizationId: orgId,
      originalFilename: "W-9-Form-Acme-Corp.pdf",
      displayTitle: "W-9 Form — Acme Corp",
      summary: "Tax identification form (W-9) submitted by Acme Corporation for vendor payments.",
      documentType: "tax_form" as const,
      fileType: "pdf" as const,
      storagePath: "local://documents/w9-acme-corp.pdf",
      fileSizeBytes: 128_000,
      mimeType: "application/pdf",
    },
    {
      organizationId: orgId,
      originalFilename: "INV-2026-0042-Marketing-Agency.pdf",
      displayTitle: "Marketing Agency Invoice #0042",
      summary:
        "Monthly retainer invoice from BrightSpark Marketing for January 2026 social media management.",
      documentType: "invoice" as const,
      fileType: "pdf" as const,
      storagePath: "local://documents/inv-2026-0042-marketing.pdf",
      fileSizeBytes: 98_304,
      mimeType: "application/pdf",
    },
  ];

  const inserted = await db.insert(documents).values(sampleDocuments).returning();

  console.log(`✅ Inserted ${inserted.length} documents:`);
  for (const doc of inserted) {
    console.log(`   • ${doc.displayTitle} (${doc.fileType})`);
  }
}

main().catch(console.error);
