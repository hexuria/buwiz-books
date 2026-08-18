import { describe, expect, it } from "vitest";
import {
  buildFilingWorkspace,
  FILING_STAGE_ORDER,
  type FilingWorkspaceInput,
} from "@/lib/tax/filing-workspace";

/**
 * Every engine already knows its own blockers. This module collects and ORDERS
 * them; it does not re-derive them, because a second opinion can disagree with
 * the first and the user would see whichever happened to be wired to the screen.
 *
 * The ordering is the actual product. Some blockers make others unresolvable —
 * a filer facing nine of them needs to know which to fix first, or they fix a
 * symptom and watch three more appear.
 */
const clean: FilingWorkspaceInput = {
  period: {
    formCode: "1604C",
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    state: "computed",
    filingReference: "BIR-REF-1",
    snapshotChecksum: "abc",
    amendmentSequence: 0,
  },
  targetState: "filed",
  context: {
    unacknowledgedVariances: 0,
    fatalPreflightFindings: 0,
    hasSnapshot: true,
    filingReference: "BIR-REF-1",
    openingBalancesComplete: true,
  },
  preflightFindings: [],
  reconciliationIssues: [],
  posted: true,
};

describe("buildFilingWorkspace", () => {
  it("clears a period with nothing outstanding", () => {
    const workspace = buildFilingWorkspace(clean);
    expect(workspace.canFile).toBe(true);
    expect(workspace.blockers).toEqual([]);
    expect(workspace.nextAction).toBeNull();
  });

  it("orders blockers by dependency, not by severity or discovery", () => {
    // The load-bearing behaviour. Opening balances gate the computation, which
    // gates the review, which gates posting, and so on.
    const workspace = buildFilingWorkspace({
      ...clean,
      context: {
        unacknowledgedVariances: 2,
        fatalPreflightFindings: 1,
        hasSnapshot: false,
        filingReference: null,
        openingBalancesComplete: false,
      },
      preflightFindings: [
        { code: "ALPHA-001", severity: "fatal", message: "banned character", row: 1 } as never,
      ],
      posted: false,
      reconciliationIssues: ["control account disagrees with detail"],
    });

    const stages = workspace.blockers.map((b) => b.stage);
    const positions = stages.map((s) => FILING_STAGE_ORDER.indexOf(s));
    // Non-decreasing: the list is genuinely sorted by dependency.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(stages[0]).toBe("opening_balances");
  });

  it("names the single next action rather than only a list", () => {
    const workspace = buildFilingWorkspace({
      ...clean,
      context: { ...clean.context, openingBalancesComplete: false, hasSnapshot: false },
    });
    expect(workspace.nextAction?.stage).toBe("opening_balances");
  });

  it("explains why opening balances gate everything", () => {
    const workspace = buildFilingWorkspace({
      ...clean,
      context: { ...clean.context, openingBalancesComplete: false },
    });
    expect(workspace.blockers[0].message).toMatch(/no later check can tell/);
  });

  describe("resolvable in product, or not", () => {
    it("marks an unacknowledged variance as needing someone outside the product", () => {
      // D-N7: the client has to say their figure stands. Nobody can click that
      // on their behalf.
      const workspace = buildFilingWorkspace({
        ...clean,
        context: { ...clean.context, unacknowledgedVariances: 1 },
      });
      const variance = workspace.blockers.find((b) => b.stage === "variance_review");
      expect(variance?.resolvableInProduct).toBe(false);
    });

    it("marks a missing snapshot as something the product can do", () => {
      const workspace = buildFilingWorkspace({
        ...clean,
        context: { ...clean.context, hasSnapshot: false },
      });
      const snapshot = workspace.blockers.find((b) => b.stage === "snapshot");
      expect(snapshot?.resolvableInProduct).toBe(true);
    });

    it("marks a missing TIN as needing the employee, not a fix in the app", () => {
      const workspace = buildFilingWorkspace({
        ...clean,
        preflightFindings: [
          { code: "ALPHA-003-TIN", severity: "fatal", message: "no TIN", row: 4 } as never,
        ],
      });
      const finding = workspace.blockers.find((b) => b.stage === "preflight");
      expect(finding?.resolvableInProduct).toBe(false);
    });

    it("marks a banned character as fixable in the app", () => {
      // Transliteration is something the product does.
      const workspace = buildFilingWorkspace({
        ...clean,
        preflightFindings: [
          { code: "ALPHA-001", severity: "fatal", message: "banned char", row: 2 } as never,
        ],
      });
      const finding = workspace.blockers.find((b) => b.stage === "preflight");
      expect(finding?.resolvableInProduct).toBe(true);
    });
  });

  it("ignores non-fatal pre-flight findings", () => {
    const workspace = buildFilingWorkspace({
      ...clean,
      preflightFindings: [
        { code: "ALPHA-009", severity: "warning", message: "odd name", row: 3 } as never,
      ],
    });
    expect(workspace.blockers).toEqual([]);
    expect(workspace.canFile).toBe(true);
  });

  it("carries reconciliation issues through verbatim", () => {
    // Already phrased by the form builder; rewording them here would create a
    // second version of the same finding.
    const workspace = buildFilingWorkspace({
      ...clean,
      reconciliationIssues: ["the control account moved by 100 but the detail totals 90"],
    });
    expect(workspace.blockers[0].message).toBe(
      "the control account moved by 100 but the detail totals 90",
    );
  });

  it("surfaces a state-machine refusal this module did not anticipate", () => {
    // The state machine gets the last word. A reason it raises that none of the
    // checks above produced must still reach the user rather than vanish.
    const workspace = buildFilingWorkspace({
      ...clean,
      period: { ...clean.period, state: "filed" },
      targetState: "computed",
    });
    expect(workspace.canFile).toBe(false);
    expect(workspace.blockers.length).toBeGreaterThan(0);
  });

  it("reports per-stage status for a progress view", () => {
    const workspace = buildFilingWorkspace({
      ...clean,
      context: { ...clean.context, hasSnapshot: false },
    });
    const snapshot = workspace.stages.find((s) => s.stage === "snapshot");
    const posting = workspace.stages.find((s) => s.stage === "posting");
    expect(snapshot?.status).toBe("blocked");
    expect(snapshot?.blockerCount).toBe(1);
    expect(posting?.status).toBe("clear");
  });

  it("covers every stage in the progress view, blocked or not", () => {
    const workspace = buildFilingWorkspace(clean);
    expect(workspace.stages.map((s) => s.stage)).toEqual([...FILING_STAGE_ORDER]);
  });

  it("does not claim it can file while the state machine refuses", () => {
    const workspace = buildFilingWorkspace({
      ...clean,
      context: { ...clean.context, filingReference: null },
    });
    expect(workspace.canFile).toBe(false);
  });
});
