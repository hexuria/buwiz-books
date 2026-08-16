// ============================================================================
// Pre-egress PII redaction (AI_MULTIPROVIDER_PLAN §2.4/§2.5, mandatory).
//
// Every TEXT prompt is redacted before it reaches any provider — including
// Gemini, not just the new Anthropic/OpenAI hops. Account numbers, card PANs,
// routing numbers, SSNs and IBANs are masked to their last 4 digits.
//
// Deliberate posture: OVER-masking is safe, under-masking is not. A masked
// invoice number costs the model a little context; a leaked account number is
// a breach. Where a pattern is ambiguous we mask.
//
// HONEST LIMITATION: this cannot touch inline document BYTES (a scanned
// statement image is the thing OCR exists to read). That is exactly why OCR
// task chains stay Gemini-only — the vendor that already receives these
// documents — until a document-DLP pass exists. Provider allowlisting is the
// consent mechanism for widening that.
// ============================================================================

export interface RedactionHit {
  kind: "ssn" | "card" | "routing" | "account" | "iban";
  /** Character offset in the ORIGINAL text. */
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
    kind: "account",
    pattern: /[*X#]{2,}[ -]?(?:\d[ -]?){5,}\d\b/gi,
  },
];

/**
 * Redact PII from a text prompt.
 * Idempotent: running it on already-redacted text is a no-op.
 */
export function redactPII(text: string): RedactionResult {
  const hits: RedactionHit[] = [];
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

  return { text: output, hits };
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
