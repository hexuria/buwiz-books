/**
 * Substitute BIR Form 2307 — Certificate of Creditable Tax Withheld at Source.
 *
 * This is the agent-side paper we owe a supplier after withholding. It is a
 * substitute, not BIR artwork. Blocking issues are watermarked, not swallowed.
 */
import { jsPDF } from "jspdf";

export interface Form2307PdfInput {
  payorTin: string;
  payorRegisteredName: string;
  payeeTin: string;
  payeeRegisteredName: string;
  periodStart: string;
  periodEnd: string;
  atc: string;
  incomePayment: string;
  taxWithheld: string;
  certificateNumber?: string | null;
  blockingIssues?: string[];
}

function peso(value: string): string {
  const negative = value.trim().startsWith("-");
  const bare = negative ? value.trim().slice(1) : value.trim();
  // ROUND to centavos (half-up) — slicing the fraction TRUNCATED, so an
  // 8-decimal 1234.567 printed as 1,234.56 and the certificate disagreed
  // with every rounded figure derived from the same amount.
  const [whole, fraction = ""] = bare.split(".");
  let wholeDigits = whole === "" ? "0" : whole;
  let cents = Number(`0.${fraction || "0"}`);
  let centsRounded = Math.round(cents * 100);
  if (centsRounded === 100) {
    wholeDigits = (BigInt(wholeDigits) + 1n).toString();
    centsRounded = 0;
  }
  const grouped = wholeDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const centsText = String(centsRounded).padStart(2, "0");
  return `${negative ? "(" : ""}${grouped}.${centsText}${negative ? ")" : ""}`;
}

export function generateForm2307Pdf(input: Form2307PdfInput): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const issues = input.blockingIssues ?? [];
  const blocked = issues.length > 0;

  doc.setFont("helvetica", "bold").setFontSize(14);
  doc.text("BIR Form 2307 — substitute", 40, 48);
  doc.setFont("helvetica", "normal").setFontSize(9);
  doc.text(
    "This is a substitute certificate, not the BIR printed template. Key these figures into the official PDF if exact artwork is required.",
    40,
    66,
    { maxWidth: pageW - 80 },
  );

  const rows: Array<[string, string]> = [
    ["Payor TIN", input.payorTin],
    ["Payor registered name", input.payorRegisteredName],
    ["Payee TIN", input.payeeTin],
    ["Payee registered name", input.payeeRegisteredName],
    ["Period", `${input.periodStart} to ${input.periodEnd}`],
    ["ATC", input.atc],
    ["Income payment", peso(input.incomePayment)],
    ["Tax withheld", peso(input.taxWithheld)],
    ["Certificate no.", input.certificateNumber?.trim() || "unnumbered"],
  ];

  let y = 110;
  for (const [label, value] of rows) {
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(80);
    doc.text(label, 40, y);
    doc.setFont("helvetica", "bold").setTextColor(20);
    doc.text(value, 220, y);
    y += 18;
  }

  if (blocked) {
    y += 12;
    doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(140, 20, 20);
    doc.text("NOT FOR ISSUE", 40, y);
    y += 16;
    doc.setFont("helvetica", "normal").setFontSize(9);
    for (const issue of issues) {
      doc.text(`• ${issue}`, 40, y, { maxWidth: pageW - 80 });
      y += 14;
    }
    doc.setFont("helvetica", "bold").setFontSize(36).setTextColor(245, 205, 205);
    doc.text("NOT FOR ISSUE", pageW / 2, pageH / 2, { align: "center", angle: 28 });
  }

  return doc;
}

export function form2307PdfBuffer(input: Form2307PdfInput): string {
  return Buffer.from(generateForm2307Pdf(input).output("arraybuffer")).toString("base64");
}
