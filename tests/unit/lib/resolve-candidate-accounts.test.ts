import { describe, it, expect } from "vitest";
import { resolveCandidateAccountIds } from "../../../src/lib/resolve-candidate-accounts";

describe("resolveCandidateAccountIds", () => {
  it("returns exactly the reconciliation's own ledger account", async () => {
    // Candidates used to include every sibling under the same parent plus the
    // parent itself, while computeFinalizeBalances sums only the exact
    // account — a Checking statement line matched to a Savings journal line
    // looked matched, cleared nothing, and claimed the Savings line org-wide.
    const id = "11111111-1111-1111-1111-111111111111";
    expect(await resolveCandidateAccountIds(null as never, id)).toEqual([id]);
  });
});
