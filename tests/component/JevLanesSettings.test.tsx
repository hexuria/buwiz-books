import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Settings → Jev approval: each lane's level, agreement and sample size, its
 * calibration buckets and limits, promote / demote with the reason when a
 * promotion is not available, and the organization's switch. Admins change it;
 * everyone else sees it.
 */

const api = vi.hoisted(() => ({
  listJevLanes: vi.fn(),
  promoteJevLane: vi.fn(),
  demoteJevLane: vi.fn(),
  updateJevLaneLimits: vi.fn(),
  updateJevApprovalSettingsFn: vi.fn(),
  getJevEntryApproval: vi.fn(),
  undoJevApprovalFn: vi.fn(),
}));
vi.mock("@/routes/api/-jev-lanes", () => api);

import { ToastProvider } from "../../src/components/ui/Toast";
import {
  JevLanesPanel,
  JevLanesSettings,
  type JevLanesPanelProps,
} from "../../src/components/settings/JevLanesSettings";
import type { JevLaneView, JevLanesView } from "../../src/routes/api/-jev-lanes";

const EMPTY_BUCKETS = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98].map((lower, index, all) => ({
  lower,
  upper: all[index + 1] ?? 1,
  reviewed: 0,
  acceptance: null as number | null,
}));

function lane(overrides: Partial<JevLaneView> & Pick<JevLaneView, "id">): JevLaneView {
  return {
    partyId: "party-paper",
    partyName: "Paper Street Supply",
    docKind: "expense",
    level: "watch",
    amountCap: null,
    confidenceThreshold: null,
    promotedAt: null,
    promotedByName: null,
    demotedAt: null,
    agreement: {
      labeled: 0,
      accepted: 0,
      corrected: 0,
      rejected: 0,
      wouldApprove: 0,
      wouldApproveUndone: 0,
      remembered: 0,
    },
    eligibility: {
      eligible: false,
      total: 0,
      accepted: 0,
      acceptanceRate: 0,
      remaining: 200,
      reason: "Needs 200 more reviewed Jev answers (0/200).",
    },
    calibration: {
      buckets: EMPTY_BUCKETS,
      minimumThreshold: null,
      reason: "No threshold is supported yet: no labeled proposal carries a confidence.",
    },
    ...overrides,
  };
}

const WATCHING = lane({
  id: "lane-watch",
  partyName: "Northwind Traders",
  agreement: {
    labeled: 163,
    accepted: 161,
    corrected: 2,
    rejected: 0,
    wouldApprove: 120,
    wouldApproveUndone: 1,
    remembered: 12,
  },
  eligibility: {
    eligible: false,
    total: 163,
    accepted: 161,
    acceptanceRate: 161 / 163,
    remaining: 37,
    reason: "Needs 37 more reviewed Jev answers (163/200).",
  },
});

const SUGGESTING = lane({
  id: "lane-suggest",
  docKind: "vendor_bill",
  level: "suggest",
  agreement: {
    labeled: 250,
    accepted: 248,
    corrected: 1,
    rejected: 1,
    wouldApprove: 240,
    wouldApproveUndone: 2,
    remembered: 0,
  },
  eligibility: {
    eligible: true,
    total: 250,
    accepted: 248,
    acceptanceRate: 0.992,
    remaining: 0,
    reason: "Eligible: 99.2% accepted across 250 Jev answers.",
  },
  calibration: {
    buckets: EMPTY_BUCKETS.map((bucket) =>
      bucket.lower === 0.95
        ? { ...bucket, reviewed: 150, acceptance: 0.9933 }
        : bucket.lower === 0.98
          ? { ...bucket, reviewed: 100, acceptance: 1 }
          : bucket,
    ),
    minimumThreshold: 0.95,
    reason: "Confidence 0.95 or higher has been accepted at least 98% of the time.",
  },
});

const APPROVING = lane({
  id: "lane-auto",
  partyName: "Globex",
  level: "auto",
  amountCap: "500.00000000",
  confidenceThreshold: "0.9800",
  eligibility: { ...SUGGESTING.eligibility },
  agreement: { ...SUGGESTING.agreement },
});

function view(overrides: Partial<JevLanesView> = {}): JevLanesView {
  return {
    canConfigure: true,
    settings: {
      autoApproveEnabled: false,
      makerCheckerOptIn: false,
      spotCheckRate: 0.1,
      aiKillSwitch: false,
      requireDifferentApprover: true,
      walledKinds: ["categorize"],
    },
    lanes: [WATCHING, SUGGESTING, APPROVING],
    ...overrides,
  };
}

function renderPanel(props: Partial<JevLanesPanelProps> = {}) {
  const handlers = {
    onUpdateSettings: vi.fn(),
    onPromote: vi.fn(),
    onDemote: vi.fn(),
  };
  render(<JevLanesPanel view={view()} {...handlers} {...props} />);
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("JevLanesPanel", () => {
  it("lists each lane with its level, agreement, sample size and calibration", () => {
    renderPanel();
    const list = screen.getByRole("list", { name: "Jev approval lanes" });
    const watching = within(list).getByRole("listitem", {
      name: "Northwind Traders · Paid expense",
    });
    expect(within(watching).getByText("Watch")).toBeVisible();
    expect(
      within(watching).getByText("Agreement 98.8% · 163 reviewed (12 remembered)"),
    ).toBeVisible();
    expect(
      within(watching).getByText("Jev would have approved 120; people changed 1 of them."),
    ).toBeVisible();

    const suggesting = within(list).getByRole("listitem", {
      name: "Paper Street Supply · Vendor bill",
    });
    const calibration = within(suggesting).getByRole("table", {
      name: "Calibration for Paper Street Supply · Vendor bill",
    });
    const rows = within(calibration).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual(["0.95–0.98150" + "99.3%", "0.98–1100100%"]);
    expect(
      within(suggesting).getByText(
        "Confidence 0.95 or higher has been accepted at least 98% of the time.",
      ),
    ).toBeVisible();

    const approving = within(list).getByRole("listitem", { name: "Globex · Paid expense" });
    expect(within(approving).getByText("Auto")).toBeVisible();
    expect(
      within(approving).getByText("Approves up to 500 at confidence 0.98 or higher."),
    ).toBeVisible();
  });

  it("disables a promotion the lane has not earned, and says why", () => {
    renderPanel();
    const watching = screen.getByRole("listitem", { name: "Northwind Traders · Paid expense" });
    const promote = within(watching).getByRole("button", { name: "Promote to suggest" });
    expect(promote).toBeDisabled();
    expect(
      within(watching).getByText("Needs 37 more reviewed Jev answers (163/200)."),
    ).toBeVisible();
  });

  it("promotes to auto with a cap and a threshold prefilled from the calibration", async () => {
    const user = userEvent.setup();
    const { onPromote } = renderPanel();
    const suggesting = screen.getByRole("listitem", { name: "Paper Street Supply · Vendor bill" });
    await user.click(within(suggesting).getByRole("button", { name: "Promote to auto" }));
    expect(within(suggesting).getByLabelText("Confidence threshold")).toHaveValue("0.95");
    await user.type(within(suggesting).getByLabelText("Amount cap"), "500");
    await user.click(within(suggesting).getByRole("button", { name: "Let Jev approve" }));
    expect(onPromote).toHaveBeenCalledWith({
      laneId: "lane-suggest",
      to: "auto",
      amountCap: "500",
      confidenceThreshold: "0.95",
    });
  });

  it("demotes one step at a time", async () => {
    const user = userEvent.setup();
    const { onDemote } = renderPanel();
    await user.click(
      within(screen.getByRole("listitem", { name: "Globex · Paid expense" })).getByRole("button", {
        name: "Demote to suggest",
      }),
    );
    expect(onDemote).toHaveBeenLastCalledWith({ laneId: "lane-auto", to: "suggest" });
    await user.click(
      within(screen.getByRole("listitem", { name: "Paper Street Supply · Vendor bill" })).getByRole(
        "button",
        { name: "Demote to watch" },
      ),
    );
    expect(onDemote).toHaveBeenLastCalledWith({ laneId: "lane-suggest", to: "watch" });
  });

  it("switches Jev approval on for the organization and says while categories are walled", async () => {
    const user = userEvent.setup();
    const { onUpdateSettings } = renderPanel();
    expect(
      screen.getByText(
        /Jev may not apply categories on its own yet, so nothing it approves is posted/,
      ),
    ).toBeVisible();
    const toggle = screen.getByRole("switch", { name: "Let Jev approve Inbox papers" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(onUpdateSettings).toHaveBeenCalledWith({ autoApproveEnabled: true });

    await user.click(screen.getByRole("checkbox", { name: /even though this organization/ }));
    expect(onUpdateSettings).toHaveBeenLastCalledWith({ makerCheckerOptIn: true });

    const rate = screen.getByLabelText(/Spot checks/);
    expect(rate).toHaveValue("10");
    await user.clear(rate);
    await user.type(rate, "25");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onUpdateSettings).toHaveBeenLastCalledWith({ spotCheckRate: "0.2500" });
  });

  it("shows everything to members but lets them change nothing", async () => {
    const user = userEvent.setup();
    const { onUpdateSettings, onPromote } = renderPanel({ view: view({ canConfigure: false }) });
    expect(screen.getByText("Only organization admins can change Jev approval.")).toBeVisible();
    const toggle = screen.getByRole("switch", { name: "Let Jev approve Inbox papers" });
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(
      within(screen.getByRole("listitem", { name: "Paper Street Supply · Vendor bill" })).getByRole(
        "button",
        { name: "Promote to auto" },
      ),
    ).toBeDisabled();
    expect(onUpdateSettings).not.toHaveBeenCalled();
    expect(onPromote).not.toHaveBeenCalled();
  });

  it("explains an empty organization", () => {
    renderPanel({ view: view({ lanes: [] }) });
    expect(
      screen.getByText("No lanes yet. A lane starts watching the first time Jev answers a paper."),
    ).toBeVisible();
  });
});

describe("JevLanesSettings", () => {
  it("loads the lanes and saves the switch through the server functions", async () => {
    api.listJevLanes.mockResolvedValue(view());
    api.updateJevApprovalSettingsFn.mockResolvedValue({
      autoApproveEnabled: true,
      makerCheckerOptIn: false,
      spotCheckRate: 0.1,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <JevLanesSettings />
        </ToastProvider>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("switch", { name: "Let Jev approve Inbox papers" }));
    await waitFor(() =>
      expect(api.updateJevApprovalSettingsFn).toHaveBeenCalledWith({
        data: { autoApproveEnabled: true },
      }),
    );
    expect(await screen.findByText("Jev approval settings saved.")).toBeInTheDocument();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(["jev"]);
  });
});
