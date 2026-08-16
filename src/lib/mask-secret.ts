/**
 * Mask any stored secret as `••••<last4>` for display. The last 4 characters
 * are enough for a human to tell two keys apart without being enough to use
 * either — this is the ONLY shape credential material may take in a response
 * body.
 */
export function maskSecret(value: string): string {
  return `••••${value.slice(-4)}`;
}

/**
 * Mask Gemini API keys as `••••<last4>` for display. Two keys sharing a last-4
 * are disambiguated with a suffix (`••••1234 (2)`) so a masked round-trip on
 * save can map each mask back to exactly one stored key — a plain last-4 mask
 * would collapse duplicates and silently drop a live key.
 *
 * The output order matches the input order, so the caller can rebuild a
 * mask→key map by zipping `maskGeminiKeys(stored)` with `stored`.
 */
export function maskGeminiKeys(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const base = maskSecret(key);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}
