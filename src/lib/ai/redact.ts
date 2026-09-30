// ============================================================================
// Pre-egress PII redaction (AI_MULTIPROVIDER_PLAN §2.4/§2.5, mandatory).
//
// Every TEXT prompt is redacted before it reaches any provider — including
// Gemini, not just the new Anthropic/OpenAI hops. Account numbers, card PANs,
// routing numbers, SSNs, IBANs and Philippine government IDs (TIN, SSS,
// PhilHealth PIN, Pag-IBIG/HDMF MID) are masked to their last 4 digits.
//
// Deliberate posture: OVER-masking is safe, under-masking is not. A masked
// invoice number costs the model a little context; a leaked account number is
// a breach. Where a pattern is ambiguous we mask.
//
// Money amounts are never a target: the model needs them. No rule accepts a
// comma-grouped figure or a digit run that continues into a decimal fraction.
//
// Redaction runs to a FIXED POINT. One rule's mask can create the boundary
// another rule needs: in `219-44-2138XXXX-5620-1278` the SSN is glued to the
// X-run, so `\b` never fires until the masked-account rule has turned
// `XXXX-5620-1278` into stars. Each pass that changes anything removes digits,
// so the loop always terminates; MAX_REDACTION_PASSES is only a backstop.
//
// HONEST LIMITATION: this cannot touch inline document BYTES (a scanned
// statement image is the thing OCR exists to read). That is exactly why OCR
// task chains stay Gemini-only — the vendor that already receives these
// documents — until a document-DLP pass exists. Provider allowlisting is the
// consent mechanism for widening that.
// ============================================================================

export interface RedactionHit {
  kind:
    | "ssn"
    | "card"
    | "routing"
    | "account"
    | "iban"
    | "ph_tin"
    | "ph_sss"
    | "ph_philhealth"
    | "ph_pagibig";
  /**
   * Character offset in the text the rule scanned. Earlier masks (from a
   * preceding rule or pass) can shift it relative to the original input.
   */
  index: number;
  length: number;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}

/** Keep the last 4 characters of a digit run, mask the rest. */
function maskKeepLast4(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 4) return value;
  const last4 = digits.slice(-4);
  return `${"*".repeat(Math.max(4, digits.length - 4))}${last4}`;
}

/** Luhn check — distinguishes real card PANs from arbitrary digit runs. */
export function isLuhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ABA routing checksum (3·7·1 weighting). */
export function isAbaRoutingValid(digits: string): boolean {
  if (digits.length !== 9) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    sum += d * w[i];
  }
  return sum % 10 === 0;
}

interface Rule {
  kind: RedactionHit["kind"];
  pattern: RegExp;
  /** Extra confirmation beyond the pattern (checksums, context). */
  accept?: (match: RegExpExecArray) => boolean;
}

// ── Philippine government IDs ───────────────────────────────────────────────
//
//   TIN         ###-###-###, plus an optional branch code (###-###-###-000 or
//               the newer 5-digit ###-###-###-00000)
//   SSS         ##-#######-#
//   PhilHealth  ##-#########-#   (the PIN)
//   Pag-IBIG    ####-####-####   (HDMF Membership ID, "MID")
//
// Two tiers, trading coverage against false positives:
//
//  • DASHED shapes are masked with or without a label. Payroll registers and
//    remittance lists print these in table columns, where the label sits in a
//    header row far from the value, so requiring one would leak them. None of
//    the shapes collides with a date (2026-01-31), a PH phone number
//    (0917-123-4567, (02) 8123-4567) or a money amount (1,234,567.89).
//    Accepted over-masking: a reference or document number that happens to
//    have exactly one of these dashed shapes is masked to its last 4. The
//    4-4-4 Pag-IBIG shape is the loosest of the four; it is still masked,
//    per the posture above, because an MID in a table is unlabeled.
//
//  • UNSEPARATED and SPACE-SEPARATED forms are masked only after a label
//    ("TIN", "SSS No.", "PhilHealth PIN", "Pag-IBIG MID", "HDMF"). Bare digit
//    runs and space-grouped digits are too often invoice numbers, check
//    numbers or amounts, so without the label they are left alone.
//
// Boundaries are context-aware rather than plain `\b`:
//  • ID_START refuses a dashed shape glued to a preceding word or dash, so a
//    prefixed document number such as INV-2026-0001-0042 survives, and the
//    back half of a longer dashed run is never picked out.
//  • ID_END refuses a run that continues into another digit, dash-digit group
//    or decimal fraction. The first 12 digits of a dashed 16-digit card are
//    therefore never mistaken for an MID (the card rule masks the whole PAN,
//    where a partial mask would have left 8 digits visible), and the integer
//    part of an amount is never consumed.
//  • A branch code attaches with a dash or no separator, never a space, so a
//    labeled TIN cannot swallow an adjacent space-separated number. A
//    space-separated branch code survives as-is; it identifies an office of
//    the taxpayer, not the taxpayer.
const ID_START = String.raw`(?<![\w-])`;
const ID_END = String.raw`(?![-.]?\d)`;

/**
 * Words and punctuation allowed between a label and its number, same line
 * only: "TIN No.: ", "SSS#", "Pag-IBIG MID No. ", "PhilHealth Identification
 * Number (PIN): ".
 */
const LABEL_TAIL = String.raw`(?:[^\S\r\n]*(?:\(?(?:TIN|PIN|MID|HDMF|FUND|MEMBERSHIP|MEMBER|IDENTIFICATION|ID|NUMBER|NUM|NO)\b\)?\.?|[:#.(\-]))*[^\S\r\n]*`;

/** Label, connecting words, then the number as capture group 1. */
function labeledId(label: string, digits: string): RegExp {
  return new RegExp(String.raw`\b(?:${label})${LABEL_TAIL}(${digits})${ID_END}`, "gi");
}

const PH_ID_RULES: Rule[] = [
  {
    kind: "ph_tin",
    pattern: new RegExp(String.raw`${ID_START}\d{3}-\d{3}-\d{3}(?:-\d{3,5})?${ID_END}`, "g"),
  },
  {
    // 3–5 branch digits: a mistyped 4-digit code must not leave the TIN
    // itself unmasked.
    kind: "ph_tin",
    pattern: labeledId(
      String.raw`TIN|T\.I\.N|TAX(?:PAYER)?\s+IDENTIFICATION`,
      String.raw`\d{3}[- ]?\d{3}[- ]?\d{3}(?:-?\d{3,5})?`,
    ),
  },
  {
    kind: "ph_sss",
    pattern: new RegExp(String.raw`${ID_START}\d{2}-\d{7}-\d${ID_END}`, "g"),
  },
  {
    kind: "ph_sss",
    pattern: labeledId(
      String.raw`SSS|SOCIAL\s+SECURITY\s+SYSTEM`,
      String.raw`\d{2}[- ]?\d{7}[- ]?\d`,
    ),
  },
  {
    kind: "ph_philhealth",
    pattern: new RegExp(String.raw`${ID_START}\d{2}-\d{9}-\d${ID_END}`, "g"),
  },
  {
    kind: "ph_philhealth",
    pattern: labeledId(String.raw`PHIL[- ]?HEALTH|PHIC|PIN`, String.raw`\d{2}[- ]?\d{9}[- ]?\d`),
  },
  {
    kind: "ph_pagibig",
    pattern: new RegExp(String.raw`${ID_START}\d{4}-\d{4}-\d{4}${ID_END}`, "g"),
  },
  {
    kind: "ph_pagibig",
    pattern: labeledId(String.raw`PAG[- ]?IBIG|HDMF|MID`, String.raw`\d{4}[- ]?\d{4}[- ]?\d{4}`),
  },
];

// Order matters: the most specific patterns run first so a card number is
// not first consumed by the generic account rule.
const RULES: Rule[] = [
  {
    kind: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    // Labeled SSN without dashes ("SSN: 123456789") — unlabeled 9-digit runs
    // are left to the routing/account rules.
    kind: "ssn",
    pattern: /\b(?:SSN|SOCIAL SECURITY(?: NUMBER)?)\s*[:#]?\s*(\d{9})\b/gi,
  },
  // Before the card rule, so a TIN with a 5-digit branch code (14 digits) is
  // reported as a TIN rather than whatever a Luhn coincidence makes it.
  ...PH_ID_RULES,
  {
    kind: "iban",
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  },
  {
    kind: "card",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    accept: (m) => isLuhnValid(m[0].replace(/\D/g, "")),
  },
  {
    kind: "routing",
    pattern: /\b(?:ROUTING|ABA|RTN)\s*(?:NUMBER|NO\.?|#)?\s*[:#]?\s*(\d{9})\b/gi,
    accept: (m) => isAbaRoutingValid(m[1] ?? m[0].replace(/\D/g, "")),
  },
  {
    // Labeled account numbers: "Account #12345678", "Acct: 1234-5678-90".
    kind: "account",
    pattern: /\b(?:ACCOUNT|ACCT|A\/C)\s*(?:NUMBER|NO\.?|#)?\s*[:#]?\s*((?:\d[ -]?){7,17}\d)\b/gi,
  },
  {
    // Masked-but-partially-revealed forms ("****1234567" / "XXXX-1234-5678").
    // No leading \b: `*` and `#` are non-word chars, so a boundary assertion
    // would never fire after a space.
    // The run may not stop just short of a decimal fraction: in
    // "*****6789 1250.00" (an ID masked by an earlier rule, then an amount)
    // the digits after the space are money, not more of the identifier.
    kind: "account",
    pattern: /[*X#]{2,}[ -]?(?:\d[ -]?){5,}\d\b(?![.,]\d)/gi,
  },
];

/**
 * Backstop for the fixed-point loop. Termination does not depend on it: a
 * pass that changes the text replaces digits with `*`, so the digit count
 * strictly falls. Real prompts settle in 2 passes (a change, then a
 * confirming no-op); adjacency chains in the tests take 3.
 */
const MAX_REDACTION_PASSES = 5;

/**
 * Redact PII from a text prompt.
 * Idempotent: passes repeat until the text stops changing, so running it on
 * already-redacted text is a no-op.
 */
export function redactPII(text: string): RedactionResult {
  const hits: RedactionHit[] = [];
  let output = text;

  for (let pass = 0; pass < MAX_REDACTION_PASSES; pass++) {
    const next = redactPass(output, hits);
    if (next === output) break;
    output = next;
  }

  return { text: output, hits };
}

/** One application of every rule, in order. Appends to `hits`. */
function redactPass(text: string, hits: RedactionHit[]): string {
  let output = text;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    let match: RegExpExecArray | null;

    while ((match = rule.pattern.exec(output)) !== null) {
      if (match[0].length === 0) {
        rule.pattern.lastIndex++;
        continue;
      }
      if (rule.accept && !rule.accept(match)) continue;

      // Preserve any label prefix; mask only the digits.
      const captured = match[1];
      const target = captured ?? match[0];
      const targetStart = captured ? match[0].lastIndexOf(captured) + match.index : match.index;
      const masked = maskKeepLast4(target);
      if (masked === target) continue;

      replacements.push({
        start: targetStart,
        end: targetStart + target.length,
        value: masked,
      });
      hits.push({ kind: rule.kind, index: targetStart, length: target.length });
    }

    // Apply right-to-left so earlier offsets stay valid.
    for (const r of replacements.reverse()) {
      output = output.slice(0, r.start) + r.value + output.slice(r.end);
    }
  }

  return output;
}

/**
 * Branded redacted prompt. Adapters accept ONLY this type, so a call path
 * cannot reach a provider with unredacted text and still typecheck — the
 * mandatory pass is enforced structurally, not by discipline.
 */
export type RedactedPrompt = string & { readonly __redacted: unique symbol };

export function toRedactedPrompt(text: string): { prompt: RedactedPrompt; hits: RedactionHit[] } {
  const { text: redacted, hits } = redactPII(text);
  return { prompt: redacted as RedactedPrompt, hits };
}
