import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ratchet for the audit's background-DB-discipline systemic pattern.
 *
 * Job handlers run with no request, so nothing stops a query from riding the
 * module-level connection with no org context — silently unscoped today
 * (every RLS policy has the permissive IS NULL escape) and silently EMPTY
 * once the planned hardening drops the escape. Both failure modes are
 * invisible in tests that connect as the table owner.
 *
 * The discipline: handlers open short withOrgContext transactions per DB
 * phase (external I/O — Resend, R2, model calls — stays outside), and the
 * scaffolding primitives own their context (runStep and
 * extendProcessingJobLease take orgId, not an executor). The ONE sanctioned
 * cross-org read is the job claim in processing-job-lease.ts.
 */
describe("background db discipline", () => {
  const root = join(__dirname, "../..");
  const read = (rel: string) => readFileSync(join(root, rel), "utf-8");
  const HANDLERS_DIR = "src/lib/jobs/handlers";

  // Files allowed to import the bare `db` binding, each tied to a documented
  // justification that must remain in the file. This list only shrinks.
  const BARE_DB_ALLOWLIST: Record<string, string> = {
    "match-assist.ts": "DOCUMENTED exception",
  };

  it("no job handler imports the module-level db (documented exceptions aside)", () => {
    const files = readdirSync(join(root, HANDLERS_DIR)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const source = read(join(HANDLERS_DIR, file));
      const importsBareDb = /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["'][^"']*\/db["']/.test(
        source.replaceAll("type DbExecutor", "").replaceAll("withOrgContext", ""),
      );
      const justification = BARE_DB_ALLOWLIST[file];
      if (justification) {
        expect(source, `${file} lost its documented bare-db justification`).toContain(
          justification,
        );
      } else {
        expect(importsBareDb, `${file} imports the module-level db`).toBe(false);
      }
    }
  });

  it("runStep owns its org context and no longer accepts an executor", () => {
    const source = read("src/lib/ai/agent-run.ts");
    expect(source).toContain(
      "export async function runStep<T = unknown>(\n  run: { runId: string; orgId: string; processingJobId?: string },",
    );
    expect(source).toContain('withOrgContext(run.orgId, "system", "admin"');
  });

  it("lease extension takes the job's orgId; the claim stays the one documented cross-org read", () => {
    const source = read("src/lib/inbox/processing-job-lease.ts");
    expect(source).toContain(
      "export async function extendProcessingJobLease(\n  orgId: string,\n  jobId: string,",
    );
    expect(source).toContain("the one documented cross-org");
    // The claim itself is untouched: cross-org SELECT ... FOR UPDATE SKIP LOCKED.
    expect(source).toContain("export async function claimNextProcessingJob(");
  });

  it("the AI settings read takes the caller's executor", () => {
    const source = read("src/lib/ai/settings.ts");
    expect(source).toContain(
      "export async function getOrgAiSettings(\n  executor: DbExecutor,\n  orgId: string,\n)",
    );
    expect(source).not.toContain('import { db } from "../../db"');
  });

  it("the draft screen's invoice-number GET peeks; only createInvoice allocates", () => {
    const source = read("src/routes/api/-invoices.ts");
    const getBlock = source.slice(
      source.indexOf("export const getNextInvoiceNumber"),
      source.indexOf("export const createInvoice"),
    );
    expect(getBlock).toContain("peekNextInvoiceNumber(orgId, db)");
    expect(getBlock).not.toContain("allocateInvoiceNumber(");
    const createBlock = source.slice(source.indexOf("export const createInvoice"));
    expect(createBlock).toContain("allocateInvoiceNumber(orgId, db)");
  });
});
