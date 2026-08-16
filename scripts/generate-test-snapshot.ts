import postgres from "postgres";
import fs from "fs";
import path from "path";

async function generateSnapshot() {
  const sql = postgres("postgresql://uriah@localhost:5432/buwiz-books");

  const tables = [
    "accounts",
    "parties",
    "dimensions",
    "financial_accounts",
    "documents",
    "journal_headers",
    "journal_lines",
    "document_attachments",
    "reconciliations",
    "statement_lines",
  ];

  let output = `/**
 * AUTO-GENERATED SNAPSHOT DATA FOR E2E TESTS
 * Generated on: ${new Date().toISOString()}
 * Used by: tests/e2e/seed-snapshot.ts
 */

export const SNAPSHOT_DATA = (orgId: string, _userId: string) => {\n`;
  output += `  return {\n`;

  // Find dynamic main mapping to resolve duplication
  const mainOrgRows = await sql.unsafe(
    "SELECT organization_id, COUNT(*) FROM journal_headers GROUP BY organization_id ORDER BY COUNT(*) DESC LIMIT 1",
  );
  const mainOrgId = mainOrgRows[0] ? mainOrgRows[0].organization_id : null;
  console.log(`Detected primary populated organization: ${mainOrgId}`);

  for (const table of tables) {
    console.log(`Snapshotting ${table}...`);
    try {
      // Find columns to conditionally append WHERE organization_id = ...
      const cols = await sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`,
      );
      const hasOrg = cols.some((c: any) => c.column_name === "organization_id");

      let query = `SELECT * FROM ${table}`;
      if (hasOrg && mainOrgId) {
        query += ` WHERE organization_id = '${mainOrgId}'`;
      }

      const records = await sql.unsafe(query);

      let json = JSON.stringify(records, null, 2);

      json = json.replace(/"organization_id":\s*"[^"]+"/g, `"organization_id": orgId`);
      json = json.replace(/"user_id":\s*"[^"]+"/g, `"user_id": userId`);

      json = json.replace(/"email":\s*"[^"]+"/g, (match) => {
        if (match.includes("hugoforbes")) return `"email": "hugoforbes88@gmail.com"`;
        if (match.includes("admin@") || match.includes("ceo@"))
          return `"email": "ceo@goldcoders.dev"`;
        return match;
      });

      output += `    ${table}: ${json},\n`;
      console.log(`  -> ${records.length} records processed.`);
    } catch (e: any) {
      console.warn(`Skipping ${table}: ${e.message}`);
    }
  }

  output += `  };\n};\n`;

  const outPath = path.resolve(process.cwd(), "tests/e2e/fixtures/snapshot-data.ts");
  fs.writeFileSync(outPath, output, "utf-8");
  console.log(`\n✅ Snapshot generated successfully at ${outPath}`);

  await sql.end();
}

generateSnapshot().catch(console.error);
