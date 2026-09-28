import { describe, expect, it, vi } from "vitest";

// The lane module imports the database module; nothing here opens a connection.
vi.mock("@/db", () => ({ db: {}, dbAdmin: {} }));

import {
  AUTONOMY_CRITERIA,
  judgeAutonomyEligibility,
  laneWalledKinds,
  LANE_APPLIED_KINDS,
  shouldDemoteFromVerdicts,
  STRUCTURAL_MANUAL_KINDS,
} from "@/lib/ai/autonomy";
import { parseLaneAmountCap } from "@/lib/ai/autonomy-lanes";
import { PARTY_PAYMENT_DETAILS_CHANGED_RULE_KEY } from "@/lib/inbox/payment-details-check";
import { PAYMENT_DETAILS_RULE_KEY } from "@/lib/inbox/jev-approval/predicate";

const verdicts = (accepted: number, other: number) => [
  ...Array<string>(accepted).fill("accepted"),
  ...Array<string>(other).fill("corrected"),
];

describe("lane eligibility (AUTONOMY_CRITERIA, shared with per-kind autonomy)", () => {
  it("needs 200 labels before anything else counts", () => {
    expect(judgeAutonomyEligibility(199, 199, "Jev answers")).toMatchObject({
      eligible: false,
      remaining: 1,
      reason: "Needs 1 more reviewed Jev answers (199/200).",
    });
  });

  it("needs at least 98% accepted", () => {
    expect(judgeAutonomyEligibility(200, 195, "Jev answers")).toMatchObject({
      eligible: false,
      reason: "Acceptance rate 97.5% is below the required 98%.",
    });
    expect(judgeAutonomyEligibility(200, 196, "Jev answers")).toMatchObject({
      eligible: true,
      reason: "Eligible: 98.0% accepted across 200 Jev answers.",
    });
  });

  it("keeps the per-kind wording for proposals", () => {
    expect(judgeAutonomyEligibility(10, 10).reason).toBe(
      "Needs 190 more reviewed proposals (10/200).",
    );
  });
});

describe("lane demotion window", () => {
  it("never demotes on fewer labels than the window", () => {
    expect(shouldDemoteFromVerdicts(verdicts(0, AUTONOMY_CRITERIA.demotionWindow - 1))).toBe(false);
  });

  it("demotes when the newest 50 labels fall below 95% accepted", () => {
    // 47 of 50 = 94%.
    expect(shouldDemoteFromVerdicts([...verdicts(0, 3), ...verdicts(47, 0)])).toBe(true);
    // 48 of 50 = 96%.
    expect(shouldDemoteFromVerdicts([...verdicts(0, 2), ...verdicts(48, 0)])).toBe(false);
  });

  it("looks only at the newest window, and counts rejections and undos as disagreement", () => {
    const newest = [...Array<string>(3).fill("rejected"), ...verdicts(47, 0)];
    const older = verdicts(0, 500);
    expect(shouldDemoteFromVerdicts([...newest, ...older])).toBe(true);
    expect(shouldDemoteFromVerdicts([...verdicts(50, 0), ...older])).toBe(false);
  });
});

describe("lane walls", () => {
  it("inbox_approve applies categorize, which is still structurally manual", () => {
    expect(LANE_APPLIED_KINDS.inbox_approve).toEqual(["categorize"]);
    expect(STRUCTURAL_MANUAL_KINDS.has("categorize")).toBe(true);
    // Until the lane gets its own exception, nothing it approves can post.
    expect(laneWalledKinds("inbox_approve")).toEqual(["categorize"]);
  });
});

describe("parseLaneAmountCap", () => {
  it("normalizes a positive decimal that fits numeric(20,8)", () => {
    expect(parseLaneAmountCap(" 500 ")).toBe("500");
    expect(parseLaneAmountCap("1250.50")).toBe("1250.5");
    expect(parseLaneAmountCap("0.00000001")).toBe("0.00000001");
  });

  it("refuses zero, negatives, sub-unit precision and oversized amounts", () => {
    for (const bad of ["0", "-5", "1.123456789", "1e3", "abc", "", "1234567890123"]) {
      expect(() => parseLaneAmountCap(bad)).toThrow(/positive amount/);
    }
  });
});

describe("predicate constants", () => {
  it("names the payee bank-detail rule the payment check raises", () => {
    expect(PAYMENT_DETAILS_RULE_KEY).toBe(PARTY_PAYMENT_DETAILS_CHANGED_RULE_KEY);
  });
});
