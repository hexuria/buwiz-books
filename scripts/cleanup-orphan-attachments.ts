/**
 * Cleanup Orphan Comment Attachments
 *
 * Finds R2 objects under the "comments/" prefix that are NOT referenced
 * by any comment row's attachments JSONB, and optionally deletes them.
 *
 * Usage:
 *   bun run scripts/cleanup-orphan-attachments.ts              # dry-run
 *   bun run scripts/cleanup-orphan-attachments.ts --delete      # actually delete
 */
import fs from "fs";
import path from "path";

// ── Load .env ──────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const envConfig = fs.readFileSync(envPath, "utf8");
      envConfig.split("\n").forEach((line) => {
        const [key, ...values] = line.split("=");
        if (key && values.length > 0 && !key.startsWith("#")) {
          const val = values
            .join("=")
            .trim()
            .replace(/^['"](.*)['"]\$/, "$1");
          if (val) process.env[key.trim()] = val;
        }
      });
      console.log("Loaded .env manually");
    }
  } catch (e) {
    console.warn("Failed to load .env:", e);
  }
}

const shouldDelete = process.argv.includes("--delete");

async function main() {
  const { db } = await import("../src/db");
  const { comments } = await import("../src/db/schema/comments");
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } =
    await import("@aws-sdk/client-s3");

  const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });

  const bucket = process.env.R2_BUCKET!;
  const prefix = "comments/";

  // ── Step 1: Collect all R2 keys referenced in comments ────────────
  console.log("📋 Scanning database for referenced attachment keys…");

  const rows = await db.select({ attachments: comments.attachments }).from(comments);

  const referencedKeys = new Set<string>();
  for (const row of rows) {
    const atts = row.attachments as { r2Key: string }[] | null;
    if (atts) {
      for (const att of atts) {
        if (att.r2Key) referencedKeys.add(att.r2Key);
      }
    }
  }
  console.log(`   Found ${referencedKeys.size} referenced keys in ${rows.length} comments.`);

  // ── Step 2: List R2 objects under comments/ prefix ────────────────
  console.log(`📦 Listing R2 objects under "${prefix}"…`);

  const r2Keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    });
    const res = await s3.send(cmd);
    if (res.Contents) {
      for (const obj of res.Contents) {
        if (obj.Key) r2Keys.push(obj.Key);
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`   Found ${r2Keys.length} objects in R2.`);

  // ── Step 3: Find orphans ──────────────────────────────────────────
  const orphans = r2Keys.filter((key) => !referencedKeys.has(key));

  if (orphans.length === 0) {
    console.log("✅ No orphaned files found. Storage is clean!");
    return;
  }

  console.log(`\n⚠️  Found ${orphans.length} orphaned files:`);
  for (const key of orphans.slice(0, 20)) {
    console.log(`   - ${key}`);
  }
  if (orphans.length > 20) {
    console.log(`   … and ${orphans.length - 20} more.`);
  }

  // ── Step 4: Delete (if flag is set) ───────────────────────────────
  if (!shouldDelete) {
    console.log("\n🔍 DRY RUN — pass --delete to actually remove these files.");
    return;
  }

  console.log(`\n🗑️  Deleting ${orphans.length} orphaned objects…`);

  // Delete in batches of 1000 (S3 limit)
  for (let i = 0; i < orphans.length; i += 1000) {
    const batch = orphans.slice(i, i + 1000);
    const cmd = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map((Key) => ({ Key })) },
    });
    const res = await s3.send(cmd);
    const deleted = res.Deleted?.length ?? 0;
    const errors = res.Errors?.length ?? 0;
    console.log(`   Batch ${Math.floor(i / 1000) + 1}: ${deleted} deleted, ${errors} errors.`);
  }

  console.log("✅ Orphan cleanup complete.");
}

main().catch(console.error);
