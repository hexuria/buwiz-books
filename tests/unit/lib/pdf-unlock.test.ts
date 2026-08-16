import { describe, expect, it } from "vitest";
import { PdfPasswordRequiredError, isPdfPasswordRequiredError } from "../../../src/lib/pdf-unlock";

// Note: probePdf / findWorkingPassword / renderPdfPagesForOcr are thin glue over
// pdf-to-img (pdfjs) and are covered end-to-end by the reconciliation +
// inbound-email integration tests with real fixture PDFs. Here we cover the
// pure error-classification helper that the worker branches on.

describe("pdf-unlock — PdfPasswordRequiredError", () => {
  it("carries a stable kind + name", () => {
    const err = new PdfPasswordRequiredError();
    expect(err.kind).toBe("password_required");
    expect(err.name).toBe("PdfPasswordRequiredError");
    expect(err).toBeInstanceOf(Error);
  });

  it("is detected by isPdfPasswordRequiredError", () => {
    expect(isPdfPasswordRequiredError(new PdfPasswordRequiredError())).toBe(true);
    // Structural match (survives serialization boundaries that drop the class).
    expect(isPdfPasswordRequiredError({ kind: "password_required" })).toBe(true);
    expect(isPdfPasswordRequiredError(new Error("other"))).toBe(false);
    expect(isPdfPasswordRequiredError(null)).toBe(false);
  });
});
