import React from "react";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The panel's container calls server functions; the presentational panel under
// test never does, so the server modules are stubbed rather than loaded.
vi.mock("@/routes/api/-rule-snapshots", () => ({
  createRuleSnapshot: vi.fn(),
  listRuleSnapshots: vi.fn(),
  pinRoutineRuleSnapshot: vi.fn(),
  unpinRoutineRuleSnapshot: vi.fn(),
}));
vi.mock("@/routes/api/-routines", () => ({ listRoutines: vi.fn() }));
vi.mock("@/lib/use-permission", () => ({
  usePermission: () => ({ canAccess: true, isLoading: false }),
}));

import {
  RuleSnapshotsPanel,
  type RoutineRuleRow,
  type RuleSnapshotRow,
} from "../../src/components/settings/RuleSnapshotsPanel";

const SNAPSHOTS: RuleSnapshotRow[] = [
  {
    id: "snap-strict",
    label: "Receipts over 10",
    createdAt: "2026-09-20T08:00:00.000Z",
    ruleCount: 14,
    pinnedBy: [{ routineId: "routine-email", routineName: "Inbound email", slot: "shadow" }],
  },
  {
    id: "snap-baseline",
    label: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    ruleCount: 14,
    pinnedBy: [{ routineId: "routine-email", routineName: "Inbound email", slot: "active" }],
  },
];

const ROUTINES: RoutineRuleRow[] = [
  {
    id: "routine-email",
    name: "Inbound email",
    ruleSnapshotId: "snap-baseline",
    shadowRuleSnapshotId: "snap-strict",
  },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof RuleSnapshotsPanel>> = {}) {
  const onCreate = vi.fn();
  const onPin = vi.fn();
  render(
    <RuleSnapshotsPanel
      snapshots={SNAPSHOTS}
      routines={ROUTINES}
      canConfigure
      onCreate={onCreate}
      onPin={onPin}
      {...overrides}
    />,
  );
  return { onCreate, onPin };
}

describe("RuleSnapshotsPanel", () => {
  it("lists snapshots with their rule counts and where they are pinned", () => {
    renderPanel();
    expect(screen.getByRole("region", { name: "Rule snapshots" })).toBeVisible();
    const list = screen.getByRole("list", { name: "Saved rule snapshots" });
    expect(within(list).getByText("Receipts over 10")).toBeVisible();
    expect(within(list).getByText("Untitled snapshot")).toBeVisible();
    expect(within(list).getByText("Shadowing Inbound email")).toBeVisible();
    expect(within(list).getByText("Pinned on Inbound email")).toBeVisible();
    expect(within(list).getAllByText(/14 rules/)).toHaveLength(2);
  });

  it("says routines run on live rules before any snapshot exists", () => {
    renderPanel({ snapshots: [], routines: [] });
    expect(screen.getByText("No snapshots yet. Routines use the live rules.")).toBeVisible();
    expect(
      screen.getByText("No routines yet. Inbound email becomes one when the first email arrives."),
    ).toBeVisible();
  });

  it("snapshots the current rules with a trimmed label", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderPanel();
    const input = screen.getByLabelText("Snapshot label");
    await user.type(input, "  Stricter receipts  ");
    await user.click(screen.getByRole("button", { name: "Snapshot current rules" }));
    expect(onCreate).toHaveBeenCalledWith("Stricter receipts");
    expect(input).toHaveValue("");
  });

  it("pins, promotes, and unpins through the routine's selects", async () => {
    const user = userEvent.setup();
    const { onPin } = renderPanel();
    const rules = screen.getByLabelText("Rules for Inbound email");
    const shadow = screen.getByLabelText("Shadow for Inbound email");
    expect(rules).toHaveValue("snap-baseline");
    expect(shadow).toHaveValue("snap-strict");
    // The enforced snapshot is not offered as its own shadow.
    expect(
      within(shadow)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["No shadow", "Receipts over 10"]);

    await user.selectOptions(rules, "snap-strict");
    expect(onPin).toHaveBeenLastCalledWith({
      routineId: "routine-email",
      snapshotId: "snap-strict",
      shadow: false,
    });
    await user.selectOptions(rules, "");
    expect(onPin).toHaveBeenLastCalledWith({
      routineId: "routine-email",
      snapshotId: null,
      shadow: false,
    });
    await user.selectOptions(shadow, "");
    expect(onPin).toHaveBeenLastCalledWith({
      routineId: "routine-email",
      snapshotId: null,
      shadow: true,
    });
  });

  it("is read-only without rule-configuration permission and shows errors", () => {
    renderPanel({ canConfigure: false, error: "Rule snapshot not found." });
    expect(screen.getByRole("button", { name: "Snapshot current rules" })).toBeDisabled();
    expect(screen.getByLabelText("Rules for Inbound email")).toBeDisabled();
    expect(screen.getByLabelText("Shadow for Inbound email")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Rule snapshot not found.");
  });
});
