/**
 * BIR Form 2316 — Certificate of Compensation Payment / Tax Withheld.
 *
 * `form-2316.ts` computes the certificate; nothing rendered it. This does.
 *
 * WHAT THIS IS AND IS NOT. This produces a legible, complete substitute
 * certificate carrying every figure the form requires, in the form's own
 * section order and with its box numbers. It is NOT a pixel replica of the
 * BIR's printed template, and it must not be described to a client as one.
 * The BIR accepts a substitute in "a form substantially similar" to the
 * official one, but the safe path for a client who wants the exact template is
 * to key these figures into the official PDF. That distinction is stated on
 * the document itself rather than left for someone to assume.
 *
 * BLOCKING ISSUES ARE RENDERED, NOT SUPPRESSED. `buildForm2316` returns
 * `blockingIssues` — a missing TIN, an absent previous-employer certificate.
 * Issuing a certificate that silently omits them would put a wrong figure in
 * an employee's hands under an employer's name. When any are present the
 * document is watermarked NOT FOR ISSUE and lists them, so an unfinished
 * certificate cannot be mistaken for a final one.
 */
import { jsPDF } from "jspdf";
import type { Form2316 } from "@/lib/tax/form-2316";

/** Two-decimal presentation. Figures arrive as exact decimal strings. */
function peso(value: string): string {
  const negative = value.trim().startsWith("-");
  const bare = negative ? value.trim().slice(1) : value.trim();
  const [whole, fraction = ""] = bare.split(".");
  const cents = `${fraction}00`.slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "(" : ""}${grouped}.${cents}${negative ? ")" : ""}`;
}

function fullName(e: Form2316["employee"]): string {
  return [e.lastName, e.firstName, e.middleName].filter(Boolean).join(", ");
}

export interface Form2316PdfOptions {
  /**
   * Optional per-item breakdown for Parts IV-A and IV-B. When omitted only the
   * section totals are printed, which is legitimate — the certificate reports
   * totals — but the itemisation is what lets a reviewer check them.
   */
  itemization?: {
    nonTaxable: Array<{ label: string; box: string; amount: string }>;
    taxableRegular: Array<{ label: string; box: string; amount: string }>;
    taxableSupplementary: Array<{ label: string; box: string; amount: string }>;
  };
}

export function generateForm2316Pdf(form: Form2316, options: Form2316PdfOptions = {}): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 40;
  const right = pageW - marginX;
  let y = 48;

  const blocked = form.blockingIssues.length > 0;

  function ensureSpace(needed: number) {
    if (y + needed <= pageH - 60) return;
    doc.addPage();
    y = 48;
  }

  function sectionHeader(title: string) {
    ensureSpace(34);
    doc.setFillColor(238, 238, 238);
    doc.rect(marginX, y - 10, right - marginX, 16, "F");
    doc.setFont("helvetica", "bold").setFontSize(8.5).setTextColor(0);
    doc.text(title, marginX + 4, y + 1);
    y += 20;
  }

  function field(label: string, value: string, box?: string) {
    ensureSpace(14);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(60);
    doc.text(box ? `${box}  ${label}` : label, marginX + 4, y);
    doc.setTextColor(0);
    doc.text(value || "—", right - 4, y, { align: "right" });
    y += 12;
  }

  function amountRow(label: string, amount: string, box?: string, bold = false) {
    ensureSpace(14);
    doc
      .setFont("helvetica", bold ? "bold" : "normal")
      .setFontSize(8)
      .setTextColor(bold ? 0 : 60);
    doc.text(box ? `${box}  ${label}` : label, marginX + 4, y);
    doc.setTextColor(0);
    doc.text(peso(amount), right - 4, y, { align: "right" });
    y += 12;
  }

  function rule() {
    doc.setDrawColor(200);
    doc.line(marginX, y - 6, right, y - 6);
  }

  // ── Title ────────────────────────────────────────────────────────────────
  doc.setFont("helvetica", "bold").setFontSize(12);
  doc.text("BIR FORM 2316", marginX, y);
  doc.setFontSize(9).setFont("helvetica", "normal");
  doc.text(`Taxable year ${form.taxableYear}`, right, y, { align: "right" });
  y += 14;
  doc.setFontSize(9.5).setFont("helvetica", "bold");
  doc.text("Certificate of Compensation Payment / Tax Withheld", marginX, y);
  y += 12;
  doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(90);
  doc.text(
    "Substitute certificate generated from payroll records. Figures are complete; the layout is not the BIR's printed template.",
    marginX,
    y,
  );
  y += 20;
  doc.setTextColor(0);

  // ── Blocking issues ──────────────────────────────────────────────────────
  if (blocked) {
    // A certificate with unresolved issues must not be mistakable for a final
    // one, so this is loud, first, and repeated as a watermark on every page.
    doc.setFillColor(255, 235, 235);
    const boxHeight = 22 + form.blockingIssues.length * 11;
    doc.rect(marginX, y - 10, right - marginX, boxHeight, "F");
    doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(150, 0, 0);
    doc.text("NOT FOR ISSUE — unresolved blocking issues", marginX + 6, y + 2);
    y += 14;
    doc.setFont("helvetica", "normal").setFontSize(7.5);
    for (const issue of form.blockingIssues) {
      doc.text(`• ${issue}`, marginX + 10, y + 2);
      y += 11;
    }
    y += 16;
    doc.setTextColor(0);
  }

  // ── Part I — Employee ────────────────────────────────────────────────────
  sectionHeader("PART I — EMPLOYEE INFORMATION");
  field("Taxpayer Identification No.", form.employee.tin, "3");
  field("Employee's Name (Last, First, Middle)", fullName(form.employee), "4");
  field("Registered Address", form.employee.address, "5");
  field("Date of Birth", form.employee.birthDate ?? "—", "7");
  field("Date Hired", form.employee.dateHired ?? "—", "9");
  field("Date Separated", form.employee.dateSeparated ?? "—", "10");
  field("Minimum Wage Earner", form.employee.isMinimumWageEarner ? "YES" : "NO", "11");
  // Never inferred from a zero balance: an employee can end with tax due
  // exactly equal to tax withheld and still be disqualified.
  field("Qualified for substituted filing", form.employee.substitutedFilingEligible ? "YES" : "NO");

  // ── Part II — Employer ───────────────────────────────────────────────────
  sectionHeader("PART II — EMPLOYER INFORMATION (PRESENT)");
  field("Taxpayer Identification No.", form.employer.tin, "13");
  field("Branch Code", form.employer.branchCode, "13B");
  field("Employer's Registered Name", form.employer.registeredName, "14");
  field("Registered Address", form.employer.address, "15");
  field("Type of Employer", form.employer.isMainEmployer ? "MAIN EMPLOYER" : "SECONDARY EMPLOYER");

  // ── Part IV-A — Non-taxable ──────────────────────────────────────────────
  sectionHeader("PART IV-A — NON-TAXABLE / EXEMPT COMPENSATION INCOME");
  for (const item of options.itemization?.nonTaxable ?? []) {
    amountRow(item.label, item.amount, item.box);
  }
  rule();
  amountRow("TOTAL NON-TAXABLE / EXEMPT COMPENSATION INCOME", form.totalNonTaxable, "24", true);

  // ── Part IV-B — Taxable ──────────────────────────────────────────────────
  sectionHeader("PART IV-B — TAXABLE COMPENSATION INCOME");
  for (const item of options.itemization?.taxableRegular ?? []) {
    amountRow(item.label, item.amount, item.box);
  }
  amountRow("Total taxable REGULAR compensation", form.totalTaxableRegular, "36", true);
  y += 4;
  for (const item of options.itemization?.taxableSupplementary ?? []) {
    amountRow(item.label, item.amount, item.box);
  }
  amountRow("Total taxable SUPPLEMENTARY compensation", form.totalTaxableSupplementary, "48", true);
  rule();
  amountRow(
    "TOTAL TAXABLE COMPENSATION — PRESENT EMPLOYER",
    form.totalTaxableFromPresentEmployer,
    "49",
    true,
  );

  // ── Part IV-B — Previous employer ────────────────────────────────────────
  sectionHeader("PREVIOUS EMPLOYER (SAME CALENDAR YEAR)");
  if (form.previousEmployer) {
    field("TIN", form.previousEmployer.tin);
    field("Registered Name", form.previousEmployer.registeredName);
    amountRow("Taxable compensation", form.previousEmployer.taxableCompensation);
    amountRow("Tax withheld", form.previousEmployer.taxWithheld);
  } else {
    // Stated explicitly. A blank section reads as "not filled in" rather than
    // "there was no previous employer", and those are different claims.
    doc.setFont("helvetica", "italic").setFontSize(8).setTextColor(90);
    doc.text("None declared for this taxable year.", marginX + 4, y);
    doc.setTextColor(0);
    y += 14;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  sectionHeader("SUMMARY");
  amountRow("Gross taxable compensation income", form.grossTaxableIncome, "21", true);
  amountRow("Tax due", form.taxDue, "51", true);
  amountRow("Tax withheld — present employer", form.taxWithheldByPresentEmployer, "52");
  amountRow("Tax withheld — previous employer", form.taxWithheldByPreviousEmployer, "53");
  rule();
  amountRow("TOTAL TAX WITHHELD", form.totalTaxWithheld, "54", true);

  const refund = Number.parseFloat(form.refundOrDeficiency);
  rule();
  amountRow(
    refund >= 0 ? "AMOUNT REFUNDED TO EMPLOYEE" : "TAX STILL DUE FROM EMPLOYEE",
    form.refundOrDeficiency,
    undefined,
    true,
  );

  // ── Deadlines ────────────────────────────────────────────────────────────
  sectionHeader("ISSUANCE");
  field("Furnish employee by", form.furnishBy);
  field("BIR copy required", form.birCopyRequired ? `YES — due ${form.birCopyDueBy ?? "—"}` : "NO");

  // ── Signatures ───────────────────────────────────────────────────────────
  ensureSpace(80);
  y += 14;
  doc.setDrawColor(120);
  const colWidth = (right - marginX - 20) / 2;
  doc.line(marginX, y + 24, marginX + colWidth, y + 24);
  doc.line(right - colWidth, y + 24, right, y + 24);
  doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(80);
  doc.text("Signature over printed name of authorised representative", marginX, y + 34);
  doc.text("Signature over printed name of employee", right - colWidth, y + 34);

  // ── Page furniture ───────────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    if (blocked) {
      // Repeated on every page: a reader who only sees page 2 must still know.
      doc.setFont("helvetica", "bold").setFontSize(38);
      doc.setTextColor(245, 205, 205);
      doc.text("NOT FOR ISSUE", pageW / 2, pageH / 2, { align: "center", angle: 28 });
    }
    doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(120);
    doc.text(
      `${form.employer.registeredName} — ${fullName(form.employee)} — ${form.taxableYear}`,
      marginX,
      pageH - 24,
    );
    doc.text(`Page ${page} of ${pageCount}`, right, pageH - 24, { align: "right" });
  }

  return doc;
}

/** Server-side buffer for attaching to an email or writing to storage. */
export function form2316PdfBuffer(form: Form2316, options?: Form2316PdfOptions): string {
  return Buffer.from(generateForm2316Pdf(form, options).output("arraybuffer")).toString("base64");
}
