import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * "by Jev" on Bills and Transactions, and Undo on the entry screen: the tag
 * only for entries Jev approved, the lane and confidence on the entry, and an
 * Undo that asks first, takes an optional reason, and refreshes what changed.
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

const permission = vi.hoisted(() => ({ canAccess: true }));
vi.mock("@/lib/use-permission", () => ({
  usePermission: () => ({ canAccess: permission.canAccess, isLoading: false }),
}));

import { ByJevTag, ByJevTagFor } from "../../src/components/jev/ByJevTag";
import { JevApprovalCard, JevApprovalPanel } from "../../src/components/jev/JevApprovalPanel";
import { ToastProvider } from "../../src/components/ui/Toast";
import type { JevEntryApproval } from "../../src/lib/inbox/jev-approval/entry";

const JOURNAL = "11111111-1111-4111-8111-111111111111";

function approval(overrides: Partial<JevEntryApproval> = {}): JevEntryApproval {
  return {
    journalHeaderId: JOURNAL,
    inboxItemId: "22222222-2222-4222-8222-222222222222",
    approvedAt: new Date("2026-08-03T10:00:00Z"),
    laneId: "33333333-3333-4333-8333-333333333333",
    laneLabel: "Paper Street Supply · Paid expense",
    confidence: 0.97,
    billId: null,
    undone: null,
    canUndo: true,
    cannotUndoReason: null,
    ...overrides,
  };
}

function setViewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /min-width:\s*(1024|768|640)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  permission.canAccess = true;
  setViewport();
});

describe("ByJevTag", () => {
  it("tags only entries Jev approved", () => {
    const { rerender } = render(<ByJevTagFor actorId="system:jev" />);
    expect(screen.getByText("by Jev")).toHaveAttribute("title", "Approved by Jev");
    rerender(<ByJevTagFor actorId="user-1" />);
    expect(screen.queryByText("by Jev")).not.toBeInTheDocument();
    rerender(<ByJevTagFor actorId={null} />);
    expect(screen.queryByText("by Jev")).not.toBeInTheDocument();
    rerender(<ByJevTag undone />);
    expect(screen.getByText("by Jev")).toHaveAttribute(
      "title",
      "Approved by Jev, then undone by a person",
    );
  });
});

describe("JevApprovalCard", () => {
  it("names the lane and confidence, and undoes after asking, with the reason", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    render(<JevApprovalCard approval={approval()} canUndo onUndo={onUndo} />);
    const region = screen.getByRole("region", { name: "Approved by Jev" });
    expect(
      within(region).getByText(
        "Jev approved this entry on the Paper Street Supply · Paid expense lane, 97% sure.",
      ),
    ).toBeVisible();

    await user.click(within(region).getByRole("button", { name: "Undo Jev approval" }));
    const dialog = await screen.findByRole("dialog", { name: "Undo Jev's approval?" });
    await user.type(within(dialog).getByLabelText("What was wrong (optional)"), "Wrong vendor");
    await user.click(within(dialog).getByRole("button", { name: "Undo approval" }));
    expect(onUndo).toHaveBeenCalledWith("Wrong vendor");
  });

  it("keeps Undo from people who cannot approve Inbox items, and says why", () => {
    render(<JevApprovalCard approval={approval()} canUndo={false} onUndo={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Undo Jev approval" })).toBeDisabled();
    expect(screen.getByText("You do not have permission to undo Inbox approvals.")).toBeVisible();
  });

  it("disables Undo when the entry can no longer be undone", () => {
    render(
      <JevApprovalCard
        approval={approval({
          canUndo: false,
          cannotUndoReason: "Payments are recorded against this bill. Void them first.",
        })}
        canUndo
        onUndo={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Undo Jev approval" })).toBeDisabled();
    expect(
      screen.getByText("Payments are recorded against this bill. Void them first."),
    ).toBeVisible();
  });

  it("says who undid an approval, with no Undo left", () => {
    render(
      <JevApprovalCard
        approval={approval({
          canUndo: false,
          cannotUndoReason: "Jev's approval was already undone.",
          undone: {
            undoneAt: new Date("2026-08-04T09:00:00Z"),
            undoneByName: "Rae Reviewer",
            reason: "Wrong category",
            reversalHeaderId: "44444444-4444-4444-8444-444444444444",
          },
        })}
        canUndo
        onUndo={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Jev approved this entry; Rae Reviewer undid it (Wrong category)."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Undo Jev approval" })).not.toBeInTheDocument();
  });
});

describe("JevApprovalPanel", () => {
  function renderPanel(onUndone = vi.fn()) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <JevApprovalPanel journalHeaderId={JOURNAL} onUndone={onUndone} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    return { invalidate, onUndone };
  }

  it("renders nothing for an entry a person approved", async () => {
    api.getJevEntryApproval.mockResolvedValue(null);
    renderPanel();
    await waitFor(() => expect(api.getJevEntryApproval).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Approved by Jev" })).not.toBeInTheDocument();
  });

  it("undoes through the server function and refreshes entries, bills, the Inbox and lanes", async () => {
    api.getJevEntryApproval.mockResolvedValue(approval());
    api.undoJevApprovalFn.mockResolvedValue({ reversalHeaderId: "r-1" });
    const user = userEvent.setup();
    const { invalidate, onUndone } = renderPanel();

    await user.click(await screen.findByRole("button", { name: "Undo Jev approval" }));
    const dialog = await screen.findByRole("dialog", { name: "Undo Jev's approval?" });
    await user.click(within(dialog).getByRole("button", { name: "Undo approval" }));

    await waitFor(() =>
      expect(api.undoJevApprovalFn).toHaveBeenCalledWith({ data: { journalHeaderId: JOURNAL } }),
    );
    expect(
      await screen.findByText("Jev's approval was undone. The paper is back in the Inbox."),
    ).toBeInTheDocument();
    const refreshed = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    for (const key of [["jev"], ["transactions"], ["bills"], ["inbox"]]) {
      expect(refreshed).toContainEqual(key);
    }
    expect(onUndone).toHaveBeenCalled();
  });
});
