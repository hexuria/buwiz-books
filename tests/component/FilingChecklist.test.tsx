import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { FilingChecklist } from "../../src/components/tax/FilingChecklist";
import {
  buildFilingWorkspace,
  type FilingWorkspaceInput,
} from "../../src/lib/tax/filing-workspace";

/**
 * The screen answers one question: can I file this, and if not, what do I fix
 * first? An unordered list of blockers is nearly useless — some make others
 * unresolvable, so a filer picking at random fixes a symptom and watches three
 * more appear.
 */
const base: FilingWorkspaceInput = {
  period: {
    formCode: "1604C",
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    state: "computed",
    filingReference: "BIR-1",
    snapshotChecksum: "abc",
    amendmentSequence: 0,
  },
  targetState: "filed",
  context: {
    unacknowledgedVariances: 0,
    fatalPreflightFindings: 0,
    hasSnapshot: true,
    filingReference: "BIR-1",
    openingBalancesComplete: true,
  },
  preflightFindings: [],
  reconciliationIssues: [],
  posted: true,
};

describe("FilingChecklist", () => {
  it("says plainly when a period is ready", () => {
    render(<FilingChecklist workspace={buildFilingWorkspace(base)} />);
    expect(screen.getByText("Ready to file")).toBeInTheDocument();
  });

  it("shows ONE next action rather than a wall of blockers", () => {
    const workspace = buildFilingWorkspace({
      ...base,
      context: {
        ...base.context,
        openingBalancesComplete: false,
        hasSnapshot: false,
        unacknowledgedVariances: 3,
      },
    });
    render(<FilingChecklist workspace={workspace} />);

    expect(screen.getByText(/Do this next/)).toBeInTheDocument();
    // And it is the earliest by dependency, not the first discovered.
    expect(screen.getByText(/Do this next/).textContent).toMatch(/Opening balances/);
  });

  it("offers a Resolve control only for blockers the product can clear", () => {
    const resolvable = buildFilingWorkspace({
      ...base,
      context: { ...base.context, hasSnapshot: false },
    });
    render(<FilingChecklist workspace={resolvable} onResolve={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
  });

  it("says outright when a blocker cannot be cleared from the screen", () => {
    // A filer should not go hunting for a control that cannot exist.
    const external = buildFilingWorkspace({
      ...base,
      context: { ...base.context, unacknowledgedVariances: 1 },
    });
    render(<FilingChecklist workspace={external} onResolve={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be cleared from here/)).toBeInTheDocument();
  });

  it("calls back with the stage when resolving", async () => {
    const onResolve = vi.fn();
    const workspace = buildFilingWorkspace({
      ...base,
      context: { ...base.context, hasSnapshot: false },
    });
    render(<FilingChecklist workspace={workspace} onResolve={onResolve} />);

    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledWith("snapshot");
  });

  it("lists every stage so cleared ones are visible too", () => {
    render(<FilingChecklist workspace={buildFilingWorkspace(base)} />);
    for (const label of [
      "Opening balances",
      "Computation",
      "Variance review",
      "Ledger posting",
      "Reconciliation",
      "As-filed snapshot",
      "Submission",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("explains the ordering when more than one blocker stands", () => {
    const workspace = buildFilingWorkspace({
      ...base,
      context: { ...base.context, hasSnapshot: false, filingReference: null },
    });
    render(<FilingChecklist workspace={workspace} />);
    expect(screen.getByText(/earlier ones make later ones unresolvable/)).toBeInTheDocument();
  });

  it("does not show the full list for a single blocker", () => {
    // One blocker is already the next action; repeating it is noise.
    const workspace = buildFilingWorkspace({
      ...base,
      context: { ...base.context, hasSnapshot: false },
    });
    render(<FilingChecklist workspace={workspace} />);
    expect(screen.queryByText(/Everything outstanding/)).not.toBeInTheDocument();
  });

  it("never shows Ready to file while anything is outstanding", () => {
    const workspace = buildFilingWorkspace({
      ...base,
      context: { ...base.context, filingReference: null },
    });
    render(<FilingChecklist workspace={workspace} />);
    expect(screen.queryByText("Ready to file")).not.toBeInTheDocument();
  });
});
