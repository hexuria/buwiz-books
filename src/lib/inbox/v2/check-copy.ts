/**
 * What a book check is called, and what fixes it, in the words a reviewer
 * uses. The Inbox pane used to title each check with its rule key run
 * through title case ("Missing Invoice"), which read as a sales invoice and
 * did not say what to do.
 */

interface CheckCopy {
  title: string;
  /** What clears it, as an instruction. */
  fix: string;
}

const CHECK_COPY: Record<string, CheckCopy> = {
  uncategorized: {
    title: "Category needed",
    fix: "Pick a category for each line still on Uncategorized.",
  },
  low_confidence_category: {
    title: "Confirm the category",
    fix: "Jev was unsure. Keep or change the category on these lines, then save.",
  },
  transaction_in_parent_category: {
    title: "Pick a more specific category",
    fix: "These lines use a parent category. Choose one of its subcategories.",
  },
  missing_vendor: {
    title: "Vendor needed",
    fix: "Choose who you paid or owe.",
  },
  missing_customer: {
    title: "Customer needed",
    fix: "Choose who paid you or owes you.",
  },
  missing_department: {
    title: "Department needed",
    fix: "Set a department on at least one line.",
  },
  missing_location: {
    title: "Location needed",
    fix: "Set a location on at least one line.",
  },
  missing_invoice: {
    title: "Vendor's bill not attached",
    fix: "Attach the bill or invoice the vendor sent you, or resolve with a note.",
  },
  missing_receipt: {
    title: "Receipt not attached",
    fix: "Attach the receipt for this purchase, or resolve with a note.",
  },
  possible_duplicate: {
    title: "Possible duplicate",
    fix: "Compare it with the match below and resolve the case.",
  },
  party_payment_details_changed: {
    title: "Payee bank details changed",
    fix: "Confirm the new bank details with the vendor before paying.",
  },
  memory_conflict: {
    title: "Remembered answers disagree",
    fix: "Jev will not guess between them. Fill in the entry yourself, then save.",
  },
  source_processing_failed: {
    title: "The paper could not be read",
    fix: "Retry processing, or reject it and upload it again.",
  },
};

function titleCase(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function checkTitle(ruleKey: string): string {
  return CHECK_COPY[ruleKey]?.title ?? titleCase(ruleKey);
}

export function checkFix(ruleKey: string): string | null {
  return CHECK_COPY[ruleKey]?.fix ?? null;
}

/**
 * The lines a check points at, named by their descriptions ("Line 2" when a
 * line has none). Null when the check is about the whole entry.
 */
export function checkLines(
  evidence: unknown,
  lines: ReadonlyArray<{ lineDescription: string | null }>,
): string | null {
  const indexes = (evidence as { lineIndexes?: unknown } | null)?.lineIndexes;
  if (!Array.isArray(indexes) || indexes.length === 0) return null;
  const names = indexes
    .filter((index): index is number => Number.isInteger(index) && index >= 0)
    .map((index) => lines[index]?.lineDescription?.trim() || `Line ${index + 1}`);
  return names.length > 0 ? names.join(", ") : null;
}

/**
 * What a save changed, for the toast: which blocking checks it cleared and
 * which still block approval.
 */
export function summarizeCheckChange(before: readonly string[], after: readonly string[]): string {
  const cleared = before.filter((ruleKey) => !after.includes(ruleKey));
  const parts = ["Saved."];
  if (cleared.length > 0) parts.push(`Cleared: ${cleared.map(checkTitle).join(", ")}.`);
  if (after.length === 0) parts.push("Nothing blocks approval.");
  else parts.push(`Still blocking: ${after.map(checkTitle).join(", ")}.`);
  return parts.join(" ");
}
