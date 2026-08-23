/**
 * Received 2307 capture, CWT recognition, and SAWT — Stage 3a.
 *
 * When a customer withholds expanded withholding tax from a payment to us,
 * they remit it to the BIR on our behalf and issue a 2307. Three things follow,
 * and conflating any two of them is how this goes wrong:
 *
 *   1. The RECEIVABLE. The withheld amount is an asset — creditable withholding
 *      tax we will offset against income tax. It is recognised when the payment
 *      is received, not when the paper arrives.
 *   2. The CERTIFICATE. The paper is the only evidence the BIR accepts. Without
 *      it the credit is disallowed at assessment no matter what the ledger
 *      says, so its arrival is tracked separately from the accounting.
 *   3. The SAWT. The Summary Alphalist of Withholding Taxes is filed with the
 *      income tax return and must reconcile to the receivable.
 *
 * THE ENTRY, at the point a customer pays net of withholding:
 *
 *     DR  Cash                          amount actually received
 *     DR  CWT receivable                tax the customer withheld
 *         CR  Accounts receivable       the full invoice amount
 *
 * The invoice is fully settled even though less cash arrived — that is the
 * point. Treating the withheld portion as a discount or a write-off loses the
 * credit entirely, which is the most expensive mistake available here: the
 * money has already been remitted to the BIR in our name.
 */
import { addAll, fromScaled, toScaled, ZERO, type ScaledMoney } from "@/lib/tax/money";
import { isPlaceholderTin } from "@/lib/tax/alphalist-preflight";

export class CertificateValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "CertificateValidationError";
  }
}

export interface Received2307Input {
  payorTin: string;
  payorRegisteredName: string;
  certificateNumber?: string | null;
  periodStart: string;
  periodEnd: string;
  atc: string;
  incomePayment: string;
  taxWithheld: string;
}

/** A normalized 9- or 12-digit TIN, or a validation error. */
export function normalizeTin(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 9 && digits.length !== 12) {
    throw new CertificateValidationError(
      `TIN ${JSON.stringify(raw)} has ${digits.length} digits; a Philippine TIN has 9 (or 12 ` +
        `with the branch code). A wrong TIN puts the credit against the wrong taxpayer.`,
      "payorTin",
    );
  }
  // Branch code omitted means head office, which is 000 on the SAWT.
  return digits.length === 9 ? `${digits}000` : digits;
}

/**
 * The implied withholding rate, in basis points.
 *
 * Derived rather than assumed: a certificate states both amounts, and the rate
 * is what they imply. Comparing it against the ATC's expected rate is how a
 * transposed figure is caught — the constraint that withheld <= payment stops
 * the gross cases, but 2% keyed as 20% passes that and is still wrong.
 */
export function impliedRateBps(incomePayment: string, taxWithheld: string): number | null {
  const payment = toScaled(incomePayment);
  if (payment === ZERO) return null;
  const withheld = toScaled(taxWithheld);
  // Basis points rounded HALF-UP to the nearest whole — bigint division
  // truncates, and truncation read 9.999…% as 999 bps, flagging correct
  // certificates one basis point under their table rate.
  return Number((withheld * 20000n + payment) / (2n * payment));
}

/**
 * Expected rates by ATC, in basis points.
 *
 * Deliberately small and explicit. These are the codes a professional-services
 * or goods-supplying SMB actually meets; an unknown ATC returns null and the
 * rate check is skipped rather than guessed, because inventing an expected
 * rate would produce a confident warning about a correct certificate.
 */
export const ATC_EXPECTED_RATE_BPS: Record<string, number> = {
  // Professional fees — individual payee, RR 11-2018 as amended
  WI010: 500,
  WI011: 1000,
  // Professional fees — corporate payee
  WC010: 1000,
  WC011: 1500,
  // Rentals
  WI100: 500,
  WC100: 500,
  // Contractors
  WI120: 200,
  WC120: 200,
  // Goods — top withholding agents
  WC158: 100,
  WI158: 100,
  // Services — top withholding agents
  WC160: 200,
  WI160: 200,
};

export interface CertificateWarning {
  code: string;
  message: string;
}

/**
 * Validate a captured certificate, returning blocking errors by throwing and
 * non-blocking concerns as warnings.
 *
 * The split matters: a malformed TIN cannot be stored at all, but a rate that
 * disagrees with the ATC's usual figure is often legitimate (a payee with a
 * sworn declaration, a mixed-rate engagement) and must not stop capture.
 */
export function validateReceived2307(input: Received2307Input): {
  normalized: Received2307Input & { payorTin: string };
  warnings: CertificateWarning[];
} {
  const warnings: CertificateWarning[] = [];
  const payorTin = normalizeTin(input.payorTin);
  if (isPlaceholderTin(payorTin)) {
    throw new CertificateValidationError(
      `TIN ${JSON.stringify(input.payorTin)} is a placeholder; dummy TINs are banned.`,
      "payorTin",
    );
  }

  if (!input.payorRegisteredName.trim()) {
    throw new CertificateValidationError(
      "The payor's registered name is required — the SAWT reports it and a blank name is rejected.",
      "payorRegisteredName",
    );
  }
  if (!input.atc.trim()) {
    throw new CertificateValidationError(
      "An ATC is required: it decides both the rate and the SAWT column.",
      "atc",
    );
  }

  const payment = toScaled(input.incomePayment);
  const withheld = toScaled(input.taxWithheld);
  if (payment < ZERO || withheld < ZERO) {
    throw new CertificateValidationError(
      "Amounts cannot be negative. A correction is its own reversing certificate, not a sign " +
        "flip that would net away silently in every SAWT total.",
      "incomePayment",
    );
  }
  if (withheld > payment) {
    throw new CertificateValidationError(
      `Tax withheld (${input.taxWithheld}) exceeds the income payment (${input.incomePayment}). ` +
        `This is usually a transposition, and it would inflate the credit claimed.`,
      "taxWithheld",
    );
  }
  if (input.periodEnd < input.periodStart) {
    throw new CertificateValidationError(
      `The period ends (${input.periodEnd}) before it starts (${input.periodStart}).`,
      "periodEnd",
    );
  }

  const atc = input.atc.trim().toUpperCase();
  const expected = ATC_EXPECTED_RATE_BPS[atc];
  const implied = impliedRateBps(input.incomePayment, input.taxWithheld);

  if (expected !== undefined && implied !== null && implied !== expected) {
    // A warning, not an error. 2% keyed as 20% passes every hard constraint
    // above and is still wrong, and this is what surfaces it.
    warnings.push({
      code: "RATE_MISMATCH",
      message:
        `The certificate implies ${(implied / 100).toFixed(2)}% but ATC ${atc} is normally ` +
        `${(expected / 100).toFixed(2)}%. Check the figures — or record why this payee differs.`,
    });
  }
  if (expected === undefined) {
    warnings.push({
      code: "UNKNOWN_ATC",
      message: `ATC ${atc} is not in the rate table, so the rate could not be checked.`,
    });
  }
  if (!input.certificateNumber?.trim()) {
    warnings.push({
      code: "NO_CERTIFICATE_NUMBER",
      message:
        "No certificate number. Capture is allowed, but duplicate detection cannot run without it.",
    });
  }

  return {
    normalized: { ...input, payorTin, atc },
    warnings,
  };
}

// ── SAWT ───────────────────────────────────────────────────────────────────

export interface SawtCertificate {
  payorTin: string;
  payorRegisteredName: string;
  atc: string;
  incomePayment: string;
  taxWithheld: string;
  certificateStatus: string;
}

/**
 * A 2307 belongs on a SAWT when the certificate's own quarter sits inside the
 * SAWT period. Overlap is the wrong test: a prior-quarter paper that happens
 * to arrive this quarter is still last quarter's credit.
 */
export function certificatesInSawtPeriod<T extends { periodStart: string; periodEnd: string }>(
  certificates: readonly T[],
  periodStart: string,
  periodEnd: string,
): T[] {
  if (periodEnd < periodStart) {
    throw new CertificateValidationError(
      `The SAWT period ends (${periodEnd}) before it starts (${periodStart}).`,
      "periodEnd",
    );
  }
  return certificates.filter(
    (certificate) => certificate.periodStart >= periodStart && certificate.periodEnd <= periodEnd,
  );
}

export interface SawtLine {
  payorTin: string;
  payorRegisteredName: string;
  atc: string;
  incomePayment: string;
  taxWithheld: string;
  certificateCount: number;
}

export interface Sawt {
  periodStart: string;
  periodEnd: string;
  lines: SawtLine[];
  totalIncomePayment: string;
  totalTaxWithheld: string;
  certificateCount: number;
  /** Credits claimed with no certificate in hand — disallowed at assessment. */
  pendingCertificateCount: number;
  pendingTaxWithheld: string;
  blockingIssues: string[];
}

/**
 * Build the SAWT for a period.
 *
 * Certificates are grouped by (payor TIN, ATC) because that is the SAWT's own
 * grain — one payee can withhold under two ATCs in one quarter and those are
 * separate lines, not one merged row.
 */
export function buildSawt(input: {
  periodStart: string;
  periodEnd: string;
  certificates: SawtCertificate[];
}): Sawt {
  const grouped = new Map<
    string,
    { line: SawtLine; payment: ScaledMoney; withheld: ScaledMoney }
  >();

  let totalPayment = ZERO;
  let totalWithheld = ZERO;
  let pendingCount = 0;
  let pendingWithheld = ZERO;

  for (const cert of input.certificates) {
    const key = `${cert.payorTin}${cert.atc}`;
    const payment = toScaled(cert.incomePayment);
    const withheld = toScaled(cert.taxWithheld);

    totalPayment = addAll(totalPayment, payment);
    totalWithheld = addAll(totalWithheld, withheld);

    if (cert.certificateStatus !== "received") {
      pendingCount += 1;
      pendingWithheld = addAll(pendingWithheld, withheld);
    }

    const existing = grouped.get(key);
    if (existing) {
      existing.payment = addAll(existing.payment, payment);
      existing.withheld = addAll(existing.withheld, withheld);
      existing.line.certificateCount += 1;
    } else {
      grouped.set(key, {
        payment,
        withheld,
        line: {
          payorTin: cert.payorTin,
          payorRegisteredName: cert.payorRegisteredName,
          atc: cert.atc,
          incomePayment: "0",
          taxWithheld: "0",
          certificateCount: 1,
        },
      });
    }
  }

  const lines = [...grouped.values()]
    .map(({ line, payment, withheld }) => ({
      ...line,
      incomePayment: fromScaled(payment),
      taxWithheld: fromScaled(withheld),
    }))
    // Sorted so two runs over the same data produce the same file — a SAWT
    // whose row order drifts cannot be diffed against the previous quarter.
    .sort((a, b) =>
      a.payorTin === b.payorTin ? a.atc.localeCompare(b.atc) : a.payorTin.localeCompare(b.payorTin),
    );

  const blockingIssues: string[] = [];
  if (pendingCount > 0) {
    blockingIssues.push(
      `${pendingCount} certificate(s) totalling ${fromScaled(pendingWithheld)} are not in hand. ` +
        `The BIR disallows a credit with no certificate behind it, regardless of the ledger.`,
    );
  }
  if (input.certificates.length === 0) {
    blockingIssues.push("No certificates in the period — a nil SAWT should be deliberate.");
  }

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    lines,
    totalIncomePayment: fromScaled(totalPayment),
    totalTaxWithheld: fromScaled(totalWithheld),
    certificateCount: input.certificates.length,
    pendingCertificateCount: pendingCount,
    pendingTaxWithheld: fromScaled(pendingWithheld),
    blockingIssues,
  };
}
