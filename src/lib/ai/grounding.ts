// ============================================================================
// Grounding contract (AI_NATIVE_ARCHITECTURE §2, wall 3).
//
// Models may only reference entity IDs the CALLER supplied. Any ID that is
// not in the allowed set is blanked — never silently trusted, never used to
// look something up. Names are left intact so a human reviewer still sees
// what the model meant.
//
// This runs after Zod validation and before anything is persisted, so a
// hallucinated account ID becomes an empty field a human must fill, not a
// mis-posted ledger entry.
// ============================================================================

/** Dotted path into the parsed output; `[]` walks every array element. */
export type GroundingPath = string;

export interface GroundingRule {
  /** e.g. "categoryId", "lines[].categoryId" */
  path: GroundingPath;
  /** Name of the allowed-ID set supplied by the caller. */
  set: string;
}

export interface GroundingResult<T> {
  output: T;
  /** Paths that were blanked, for telemetry and escalation decisions. */
  blanked: string[];
}

function walkAndBlank(
  node: unknown,
  segments: string[],
  allowed: Set<string>,
  trail: string,
  blanked: string[],
): void {
  if (node == null || segments.length === 0) return;
  const [head, ...rest] = segments;

  if (head.endsWith("[]")) {
    const key = head.slice(0, -2);
    const container = (node as Record<string, unknown>)[key];
    if (!Array.isArray(container)) return;
    container.forEach((item, index) => {
      walkAndBlank(item, rest, allowed, `${trail}${key}[${index}].`, blanked);
    });
    return;
  }

  const record = node as Record<string, unknown>;
  if (rest.length > 0) {
    walkAndBlank(record[head], rest, allowed, `${trail}${head}.`, blanked);
    return;
  }

  const value = record[head];
  // Empty string is the models' "I don't know" — not a violation.
  if (typeof value !== "string" || value === "") return;
  if (allowed.has(value)) return;

  record[head] = "";
  blanked.push(`${trail}${head}`);
}

/**
 * Blank every ID that isn't in its declared allowed set.
 * Mutates a structural clone and returns it, so the caller's input is safe.
 */
export function enforceGrounding<T>(
  output: T,
  rules: GroundingRule[],
  allowedIds: Record<string, Set<string>>,
): GroundingResult<T> {
  if (rules.length === 0) return { output, blanked: [] };

  const cloned = structuredClone(output);
  const blanked: string[] = [];

  for (const rule of rules) {
    const allowed = allowedIds[rule.set];
    // No set supplied ⇒ nothing is allowed ⇒ blank everything on that path.
    walkAndBlank(cloned, rule.path.split("."), allowed ?? new Set<string>(), "", blanked);
  }

  return { output: cloned, blanked };
}

/**
 * Grounding rules per task. Only tasks that echo caller-supplied IDs need
 * entries; OCR tasks that extract text have nothing to ground.
 */
export const TASK_GROUNDING: Record<string, GroundingRule[]> = {
  transaction_parse: [
    { path: "categoryId", set: "accounts" },
    { path: "partyId", set: "parties" },
    { path: "departmentId", set: "dimensions" },
    { path: "locationId", set: "dimensions" },
    { path: "transferFromCategoryId", set: "accounts" },
    { path: "transferToCategoryId", set: "accounts" },
    { path: "lines[].categoryId", set: "accounts" },
    { path: "lines[].departmentId", set: "dimensions" },
    { path: "lines[].locationId", set: "dimensions" },
  ],
  receipt_ocr: [
    { path: "categoryId", set: "accounts" },
    { path: "partyId", set: "parties" },
    { path: "lines[].categoryId", set: "accounts" },
    { path: "extractedEntities[].matchedPartyId", set: "parties" },
  ],
  txn_prefill: [
    { path: "categoryId", set: "accounts" },
    { path: "partyId", set: "parties" },
    { path: "lines[].categoryId", set: "accounts" },
  ],
  // `coaKeys` is a per-call namespace of server-minted keys ("E0".."En") for
  // the org's own accounts, not database IDs — the model never sees a uuid.
  // A blanked parentKey is not an error: validate-draft.ts degrades it to the
  // root account for that type.
  //
  // `accounts[].parentDraftKey` is deliberately absent. It names another entry
  // in the SAME response, so no allowed set can exist for it; it is validated
  // structurally in TypeScript instead.
  coa_draft: [{ path: "accounts[].parentKey", set: "coaKeys" }],
  category_mapping_suggest: [{ path: "assignments[].targetKey", set: "coaKeys" }],
};
