// ============================================================================
// Untrusted-text hygiene for prompt construction.
//
// Two prompt modules embed org-controlled strings (a business description a
// user typed, and account NAMES — which `src/lib/entity-creation.ts` writes
// straight from OCR output, so anyone with document:upload can plant text
// there). Both are JSON-encoded behind an untrusted-content preamble by the
// prompt, and both are put through this first.
//
// Stripping happens BEFORE the prompt is built so what a caller stores or
// logs is byte-identical to what was rendered; `build()` applies it again
// because the function is idempotent and a prompt must be total.
// ============================================================================

/**
 * Characters removed from untrusted text.
 *
 * C0/C1 controls (tab and newline excepted) because they corrupt text
 * columns and JSON transport, and the invisible/bidirectional block because a
 * right-to-left override can make a hostile account name render as something
 * harmless in the review UI while still reaching the model verbatim.
 */
function isStrippable(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false; // keep tab + newline
  if (code <= 0x1f) return true; // C0
  if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1
  if (code >= 0x200b && code <= 0x200f) return true; // zero-width, LRM/RLM
  if (code === 0x2028 || code === 0x2029) return true; // line/paragraph separator
  if (code >= 0x202a && code <= 0x202e) return true; // bidi embedding/override
  if (code >= 0x2060 && code <= 0x2064) return true; // invisible operators
  if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolates
  if (code === 0xfeff) return true; // BOM / zero-width no-break space
  return false;
}

export function stripControlChars(value: string): string {
  let out = "";
  for (const char of value.replace(/\r\n/g, "\n")) {
    if (!isStrippable(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}

/**
 * Strip control characters, trim, and hard-cap the length.
 * Idempotent: `f(f(x)) === f(x)` for every input.
 */
export function sanitizeUntrustedText(value: string | null | undefined, maxChars: number): string {
  if (!value) return "";
  return stripControlChars(value).trim().slice(0, maxChars).trim();
}
