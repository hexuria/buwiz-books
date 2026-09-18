// ============================================================================
// OCR-skip MIME fixtures.
//
// CSV / text-csv statement ingest must never call vision. The predicate lives
// in statement-csv.ts; the statement_ocr job is the only caller. CI runs this
// file on every PR (test:unit) — the integration pipeline test is the
// end-to-end proof, but it is skipped without TEST_DATABASE_URL.
// ============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCsvStatementUpload } from "../../../src/lib/statement-csv";

describe("isCsvStatementUpload (vision skip)", () => {
  it.each([
    {
      name: "text/csv",
      input: { mimeType: "text/csv", fileType: "pdf", originalFilename: "scan.pdf" },
    },
    {
      name: "text/csv with charset",
      input: {
        mimeType: "text/csv; charset=utf-8",
        fileType: "pdf",
        originalFilename: "scan.pdf",
      },
    },
    {
      name: "application/csv",
      input: { mimeType: "application/csv", fileType: null, originalFilename: "stmt.bin" },
    },
    {
      name: "text/comma-separated-values",
      input: {
        mimeType: "text/comma-separated-values",
        fileType: null,
        originalFilename: "stmt.bin",
      },
    },
    {
      name: "fileType csv (MIME lying)",
      input: {
        mimeType: "application/octet-stream",
        fileType: "csv",
        originalFilename: "stmt.bin",
      },
    },
    {
      name: ".csv filename (MIME lying)",
      input: {
        mimeType: "application/octet-stream",
        fileType: "bin",
        originalFilename: "January statement.CSV",
      },
    },
  ])("skips vision when $name", ({ input }) => {
    expect(isCsvStatementUpload(input)).toBe(true);
  });

  it.each([
    {
      name: "PDF statement",
      input: {
        mimeType: "application/pdf",
        fileType: "pdf",
        originalFilename: "statement.pdf",
      },
    },
    {
      name: "image statement",
      input: { mimeType: "image/png", fileType: "png", originalFilename: "scan.png" },
    },
    {
      name: "plain text without csv markers",
      input: { mimeType: "text/plain", fileType: "txt", originalFilename: "notes.txt" },
    },
    {
      name: "empty metadata",
      input: { mimeType: null, fileType: null, originalFilename: null },
    },
  ])("does not skip vision when $name", ({ input }) => {
    expect(isCsvStatementUpload(input)).toBe(false);
  });
});

describe("statement_ocr job wiring", () => {
  const source = readFileSync(
    join(__dirname, "../../../src/lib/jobs/handlers/statement-ocr.ts"),
    "utf-8",
  );

  it("routes CSV uploads through isCsvStatementUpload before any model call", () => {
    expect(source).toContain("isCsvStatementUpload(context)");
    const csvGateAt = source.indexOf("isCsvStatementUpload(context)");
    const ocrBranchAt = source.indexOf('if (source === "ocr")');
    expect(csvGateAt).toBeGreaterThan(0);
    expect(ocrBranchAt).toBeGreaterThan(csvGateAt);
    expect(source.slice(csvGateAt, ocrBranchAt)).not.toContain("aiComplete");
    expect(source.slice(ocrBranchAt)).toContain('task: "statement_ocr"');
  });
});
