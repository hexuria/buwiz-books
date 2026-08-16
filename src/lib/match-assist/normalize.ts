// ============================================================================
// Descriptor normalization for vendor aliases.
//
// Bank statement descriptors carry per-transaction noise — store numbers,
// auth codes, dates, card suffixes ("AMZN Mktp US*2K3AB817", "SQ *COFFEE
// SHOP 0042"). Normalization strips the noise so recurring vendors collapse
// to one alias key per org.
// ============================================================================

/** Normalize a raw statement descriptor to a stable vendor alias key. */
export function normalizeDescriptor(raw: string): string {
  let value = raw.toUpperCase();

  // Drop ATTACHED star suffix codes ("AMZN MKTP US*2K3AB817") — but keep the
  // token after a detached star, which is the vendor ("SQ *COFFEE SHOP").
  value = value.replace(/(?<=\S)\*[A-Z0-9-]+/g, " ");

  // Strip common noise tokens: dates, long digit runs, auth/ref codes.
  value = value
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ") // dates
    .replace(/\b[X#]{2,}\d+\b/g, " ") // masked numbers ####1234
    .replace(/\b\d{4,}\b/g, " ") // long digit runs (store/auth/check numbers)
    .replace(
      /\b(POS|DEBIT|CREDIT|PURCHASE|PAYMENT|WITHDRAWAL|DEPOSIT|ACH|CARD|CHECKCARD|VISA|MC)\b/g,
      " ",
    );

  // Collapse punctuation and whitespace.
  value = value
    .replace(/[^A-Z0-9&' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return value;
}
