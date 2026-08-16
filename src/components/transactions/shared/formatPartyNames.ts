/**
 * formatPartyNames — Smart party name display for transaction headers.
 *
 * Rules (evaluated by party count):
 *   0  → returns empty display
 *   1  → full name, truncated at 40 chars with "…"
 *   2  → "Name1 & Name2"; if combined > 50 chars, first word of each
 *   3  → first word of each, joined: "A, B & C"
 *   4+ → first word of first 2 + "& N others"
 *
 * Returns { display, full }
 *   display = formatted string to render
 *   full    = untruncated tooltip text (null if nothing was truncated)
 */

/** Extract the first word from a name */
function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Truncate a string to maxLen chars, appending "…" if needed */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

export interface PartyNameDisplay {
  /** The formatted string to render in the UI */
  display: string;
  /** The full untruncated text for tooltip (null if nothing was truncated) */
  full: string | null;
}

export function formatPartyNames(names: string[]): PartyNameDisplay {
  // Filter out empty / blank
  const clean = names.map((n) => n.trim()).filter(Boolean);
  const count = clean.length;

  if (count === 0) {
    return { display: "", full: null };
  }

  // 1 party → full name, truncated at 40 chars
  if (count === 1) {
    const display = truncate(clean[0], 40);
    return {
      display,
      full: display !== clean[0] ? clean[0] : null,
    };
  }

  // Build the untruncated full string for tooltip comparison
  const fullJoined = joinWithAnd(clean);

  // 2 parties → "Name1 & Name2", shorten to first word if combined > 50
  if (count === 2) {
    const combined = `${clean[0]} & ${clean[1]}`;
    if (combined.length <= 50) {
      return { display: combined, full: null };
    }
    const short = `${firstWord(clean[0])} & ${firstWord(clean[1])}`;
    return { display: short, full: fullJoined };
  }

  // 3 parties → first word of each: "A, B & C"
  if (count === 3) {
    const shortened = clean.map(firstWord);
    const display = joinWithAnd(shortened);
    return { display, full: fullJoined };
  }

  // 4+ parties → first 2 first-words + "& N others"
  const display = `${firstWord(clean[0])}, ${firstWord(clean[1])} & ${count - 2} others`;
  return { display, full: fullJoined };
}

/** Join strings with ", " and " & " before the last one */
function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} & ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}
