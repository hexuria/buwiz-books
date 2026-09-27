import { describe, expect, it } from "vitest";
import {
  entryShapeOf,
  lineFactsFrom,
  modelUnsureSignalsFor,
} from "../../../src/lib/inbox/v2/model-doubt";

/**
 * Stage 2's doubts, as the Inbox v2 list reads them back: a category answer it could not use,
 * kept in the line's prediction evidence, and an unresolved counterparty from its
 * classification event. An answer it could use — a confident pick, "no fit", "new" — is not a
 * doubt, and evidence from anything but stage 2 is not either.
 */

/** A classified line as the list query returns it. */
function classified(outcome: string, extra: Record<string, unknown> = {}) {
  return {
    hasAccount: true,
    evidenceSource: "inbox_classification",
    outcome,
    confidence: null,
    ...extra,
  };
}
const paymentSide = { hasAccount: false, evidenceSource: null, outcome: null, confidence: null };

describe("modelUnsureSignalsFor", () => {
  it("reads a below-threshold category as low confidence, with the model's confidence", () => {
    const lines = lineFactsFrom([classified("low_confidence", { confidence: 0.41 }), paymentSide]);
    expect(modelUnsureSignalsFor({ lines, unresolvedParty: null })).toEqual([
      { subject: "category", cause: "low_confidence", confidence: 0.41, lineIndex: 0 },
    ]);
  });

  it("reads a failed, missing, or rejected answer as a failure, at the line it left parked", () => {
    for (const outcome of ["model_failed", "missing", "rejected"]) {
      const lines = lineFactsFrom([
        paymentSide,
        classified(outcome, { hasAccount: false, confidence: 0.9 }),
      ]);
      expect(modelUnsureSignalsFor({ lines, unresolvedParty: null }), outcome).toEqual([
        { subject: "category", cause: "failed", confidence: null, lineIndex: 1 },
      ]);
    }
  });

  it("does not count an answer it could use, or evidence stage 2 did not write", () => {
    const lines = lineFactsFrom([
      classified("picked", { confidence: 0.93 }),
      classified("no_fit", { confidence: 0.9 }),
      { ...classified("low_confidence", { confidence: 0.2 }), evidenceSource: "memory" },
      { ...classified("low_confidence"), evidenceSource: "document_extraction" },
      paymentSide,
    ]);
    expect(modelUnsureSignalsFor({ lines, unresolvedParty: null })).toEqual([]);
  });

  it("reads an unresolved counterparty by why it stayed unresolved", () => {
    expect(
      modelUnsureSignalsFor({
        lines: [],
        unresolvedParty: { outcome: "unresolved", reason: "low_confidence", confidence: 0.55 },
      }),
    ).toEqual([{ subject: "party", cause: "low_confidence", confidence: 0.55, lineIndex: null }]);
    for (const reason of ["model_failed", "unknown_choice"]) {
      expect(
        modelUnsureSignalsFor({
          lines: [],
          unresolvedParty: { outcome: "unresolved", reason, confidence: 0.7 },
        }),
        reason,
      ).toEqual([{ subject: "party", cause: "failed", confidence: null, lineIndex: null }]);
    }
    for (const outcome of ["exact", "model", "new", "not_attempted"]) {
      expect(
        modelUnsureSignalsFor({ lines: [], unresolvedParty: { outcome, confidence: 0.3 } }),
        outcome,
      ).toEqual([]);
    }
  });

  it("puts category doubts before the counterparty, and drops a confidence outside 0..1", () => {
    const lines = lineFactsFrom([classified("low_confidence", { confidence: 41 })]);
    expect(
      modelUnsureSignalsFor({
        lines,
        unresolvedParty: { outcome: "unresolved", reason: "low_confidence", confidence: "0.5" },
      }),
    ).toEqual([
      { subject: "category", cause: "low_confidence", confidence: null, lineIndex: 0 },
      { subject: "party", cause: "low_confidence", confidence: null, lineIndex: null },
    ]);
  });
});

describe("entryShapeOf", () => {
  it("counts the lines and names the ones with no account, in line order", () => {
    expect(entryShapeOf(lineFactsFrom([classified("picked"), paymentSide]))).toEqual({
      lineCount: 2,
      linesWithoutAccount: [1],
    });
    expect(entryShapeOf(lineFactsFrom([]))).toEqual({ lineCount: 0, linesWithoutAccount: [] });
  });

  it("tolerates what the query cannot promise: no lines, or an unreadable one", () => {
    expect(lineFactsFrom(null)).toEqual([]);
    expect(lineFactsFrom([null, "x"])).toEqual([
      { hasAccount: false, evidenceSource: null, outcome: null, confidence: null },
      { hasAccount: false, evidenceSource: null, outcome: null, confidence: null },
    ]);
  });
});
