import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import { ReviewRulesSettings } from "../../src/components/settings/ReviewRulesSettings";
import type { ReviewRule } from "../../src/components/settings/ReviewRuleConfigForm";

/**
 * The Settings home for per-organization review rule configuration.
 *
 * Inbox book findings read `review_rule_configs` live, so these controls are what decide whether a
 * check runs and whether its finding stops approval. The section must save through the existing
 * `updateReviewAgent` server function with the stored settings carried through untouched — the
 * server functions are mocked here, so the assertions are on exactly what would be sent.
 *
 * Unsaved drafts are guarded: a route change is held by the router blocker, answered in the page,
 * and only while something is unsaved. The router has no runtime in jsdom, so `useBlocker` is
 * replaced by a recorder and the assertions are on the options the section hands it.
 */

const api = vi.hoisted(() => ({
  listReviewAgents: vi.fn(),
  updateReviewAgent: vi.fn(),
}));
vi.mock("../../src/routes/api/-review-agents", () => api);

const permission = vi.hoisted(() => ({ configure: true }));
vi.mock("../../src/lib/use-permission", () => ({
  usePermission: (resource: string, action: string) => ({
    canAccess: resource === "agentRule" && action === "configure" ? permission.configure : true,
    isLoading: false,
  }),
}));

type BlockerOptions = {
  shouldBlockFn: (args: { current: { routeId: string }; next: { routeId: string } }) => boolean;
  disabled?: boolean;
  withResolver?: boolean;
};
type BlockerResolver =
  | { status: "idle" }
  | { status: "blocked"; proceed: () => void; reset: () => void };

const blocker = vi.hoisted(() => ({
  calls: [] as BlockerOptions[],
  resolver: { status: "idle" } as BlockerResolver,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useBlocker: (options: BlockerOptions) => {
    blocker.calls.push(options);
    return blocker.resolver;
  },
}));

/** The options from the section's most recent render. */
function blockerOptions() {
  const last = blocker.calls.at(-1);
  if (!last) throw new Error("useBlocker was never called");
  return last;
}

function rule(overrides: Partial<ReviewRule> & Pick<ReviewRule, "key" | "name" | "group">) {
  return {
    definitionId: "00000000-0000-4000-8000-000000000000",
    description: null,
    configurable: overrides.group !== "system",
    formulaVersion: 1,
    configId: null,
    enabled: true,
    impact: overrides.group === "review" ? "warning" : "blocking",
    lookbackMonths: 3,
    configJson: "{}",
    version: 0,
    updatedAt: null,
    openFindingCount: 0,
    lastRunAt: null,
    ...overrides,
  } satisfies ReviewRule;
}

const MISSING_VENDOR = rule({
  definitionId: "00000000-0000-4000-8000-000000000001",
  key: "missing_vendor",
  name: "Missing Vendor",
  group: "book",
  description: "Flag expense transactions with no vendor.",
  configId: "cfg-missing-vendor",
  version: 2,
});

const DUPLICATE = rule({
  definitionId: "00000000-0000-4000-8000-000000000002",
  key: "possible_duplicate",
  name: "Possible Duplicate",
  group: "book",
  formulaVersion: 2,
  configJson: JSON.stringify({
    mode: "enforce",
    matchWindowDays: 3,
    blockingScore: 70,
    shadowScore: 50,
    relatedAmountToleranceBps: 200,
    algorithmVersion: 4,
  }),
  version: 5,
});

const UNUSUAL_SPEND = rule({
  definitionId: "00000000-0000-4000-8000-000000000003",
  key: "unusual_spend",
  name: "Unusual Spend",
  group: "review",
  lookbackMonths: 6,
  configJson: JSON.stringify({ standardDeviations: 3 }),
  version: 1,
});

const SOURCE_FAILED = rule({
  definitionId: "00000000-0000-4000-8000-000000000004",
  key: "source_processing_failed",
  name: "Source Processing Failed",
  group: "system",
});

const RULES = [MISSING_VENDOR, DUPLICATE, UNUSUAL_SPEND, SOURCE_FAILED];

function renderSection(props: { onUnsavedChange?: (unsaved: boolean) => void } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ReviewRulesSettings {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function rowOf(name: string) {
  return screen.getByText(name, { selector: "p" }).closest("li")!;
}

async function openRule(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: `Edit ${name}` }));
}

beforeEach(() => {
  blocker.calls = [];
  blocker.resolver = { status: "idle" };
  permission.configure = true;
  api.listReviewAgents.mockReset().mockResolvedValue(RULES);
  api.updateReviewAgent.mockReset().mockResolvedValue({
    id: "cfg",
    enabled: true,
    impact: "blocking",
    lookbackMonths: 3,
    configJson: "{}",
    version: 1,
  });
});

describe("ReviewRulesSettings", () => {
  it("lists every rule under its group with its saved state", async () => {
    renderSection();

    const inbox = await screen.findByRole("region", { name: "Inbox checks" });
    const ledger = screen.getByRole("region", { name: "Ledger checks" });
    const system = screen.getByRole("region", { name: "System checks" });

    const vendorRow = within(inbox).getByText("Missing Vendor").closest("li")!;
    expect(within(vendorRow).getByText("On")).toBeInTheDocument();
    expect(within(vendorRow).getByText("Stop")).toBeInTheDocument();
    expect(
      within(vendorRow).getByText("Flag expense transactions with no vendor."),
    ).toBeInTheDocument();

    const spendRow = within(ledger).getByText("Unusual Spend").closest("li")!;
    expect(within(spendRow).getByText("Warn")).toBeInTheDocument();

    // System rules are raised with a hardcoded impact and read no config: nothing to open.
    const systemRow = within(system).getByText("Source Processing Failed").closest("li")!;
    expect(within(systemRow).getByText("Always on")).toBeInTheDocument();
    expect(within(systemRow).queryByRole("button")).toBeNull();

    expect(api.listReviewAgents).toHaveBeenCalledWith({ data: undefined });
  });

  it("turning a rule off saves through updateReviewAgent with the stored settings", async () => {
    const user = userEvent.setup();
    renderSection();

    await openRule(user, "Missing Vendor");
    const toggle = screen.getByRole("switch", { name: "Enable Missing Vendor" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateReviewAgent).toHaveBeenCalledTimes(1));
    expect(api.updateReviewAgent).toHaveBeenCalledWith({
      data: {
        definitionId: MISSING_VENDOR.definitionId,
        enabled: false,
        impact: "blocking",
        lookbackMonths: 3,
        config: {},
        // The version the list was loaded at, so a concurrent edit is rejected, not overwritten.
        expectedVersion: 2,
      },
    });
    // The saved row is re-read so the next save carries the bumped version.
    await waitFor(() => expect(api.listReviewAgents).toHaveBeenCalledTimes(2));
  });

  it("saves Stop and Warn as the stored impact values, with thresholds and lookback", async () => {
    const user = userEvent.setup();
    renderSection();

    await openRule(user, "Unusual Spend");
    const stop = screen.getByRole("radio", { name: "Stop" });
    expect(screen.getByRole("radio", { name: "Warn" })).toBeChecked();
    await user.click(stop);
    expect(stop).toBeChecked();

    const deviations = screen.getByRole("spinbutton", { name: "Standard deviations" });
    await user.clear(deviations);
    await user.type(deviations, "2.5");
    const lookback = screen.getByRole("spinbutton", { name: "Lookback window" });
    await user.clear(lookback);
    await user.type(lookback, "12");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateReviewAgent).toHaveBeenCalledWith({
        data: {
          definitionId: UNUSUAL_SPEND.definitionId,
          enabled: true,
          impact: "blocking",
          lookbackMonths: 12,
          config: { standardDeviations: 2.5 },
          expectedVersion: 1,
        },
      }),
    );
  });

  it("refuses to send a threshold the server would reject", async () => {
    const user = userEvent.setup();
    renderSection();

    await openRule(user, "Unusual Spend");
    const lookback = screen.getByRole("spinbutton", { name: "Lookback window" });
    await user.clear(lookback);
    await user.type(lookback, "30");

    expect(screen.getByText("Enter a whole number of months between 1 and 24.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(api.updateReviewAgent).not.toHaveBeenCalled();
  });

  it("asks before turning duplicate detection off, and keeps the hidden algorithm version", async () => {
    const user = userEvent.setup();
    renderSection();

    await openRule(user, "Possible Duplicate");
    const toggle = screen.getByRole("switch", { name: "Enable Possible Duplicate" });

    await user.click(toggle);
    const prompt = screen.getByRole("alert");
    expect(prompt).toHaveTextContent("Turn off duplicate detection?");
    await user.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Turn detection off" }));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateReviewAgent).toHaveBeenCalledWith({
        data: {
          definitionId: DUPLICATE.definitionId,
          enabled: false,
          impact: "blocking",
          lookbackMonths: 3,
          config: {
            mode: "enforce",
            matchWindowDays: 3,
            blockingScore: 70,
            shadowScore: 50,
            relatedAmountToleranceBps: 200,
            algorithmVersion: 4,
          },
          expectedVersion: 5,
        },
      }),
    );
  });

  it("keeps unsaved edits when a row is collapsed and reopened, and can discard them", async () => {
    const user = userEvent.setup();
    renderSection();

    await openRule(user, "Missing Vendor");
    await user.click(screen.getByRole("switch", { name: "Enable Missing Vendor" }));
    await user.click(screen.getByRole("button", { name: "Close Missing Vendor" }));
    await openRule(user, "Missing Vendor");

    const toggle = screen.getByRole("switch", { name: "Enable Missing Vendor" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(api.updateReviewAgent).not.toHaveBeenCalled();
  });

  it("is read-only without the configure permission", async () => {
    permission.configure = false;
    const user = userEvent.setup();
    renderSection();

    expect(await screen.findByRole("status")).toHaveTextContent(
      /view these rules but not change them/i,
    );
    await user.click(await screen.findByRole("button", { name: "View Missing Vendor" }));

    expect(screen.getByRole("switch", { name: "Enable Missing Vendor" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Stop" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("ReviewRulesSettings — unsaved drafts", () => {
  it("shows a collapsed row's draft, not its stored state", async () => {
    const user = userEvent.setup();
    renderSection();

    await openRule(user, "Missing Vendor");
    await user.click(screen.getByRole("switch", { name: "Enable Missing Vendor" }));
    await user.click(screen.getByRole("radio", { name: "Warn" }));
    await user.click(screen.getByRole("button", { name: "Close Missing Vendor" }));

    // The chips are spans; the editor's own labels are still in the (hidden) panel.
    const chip = { selector: "span" };
    const row = rowOf("Missing Vendor");
    expect(within(row).getByText("Unsaved", chip)).toBeVisible();
    expect(within(row).getByText("Off", chip)).toBeVisible();
    expect(within(row).getByText("Warn", chip)).toBeVisible();
    expect(within(row).queryByText("On", chip)).toBeNull();
    expect(within(row).queryByText("Stop", chip)).toBeNull();
  });

  it("holds a route change only while something is unsaved", async () => {
    const onUnsavedChange = vi.fn();
    const user = userEvent.setup();
    renderSection({ onUnsavedChange });

    await openRule(user, "Missing Vendor");
    expect(blockerOptions()).toMatchObject({ disabled: true, withResolver: true });

    await user.click(screen.getByRole("switch", { name: "Enable Missing Vendor" }));
    await waitFor(() => expect(blockerOptions().disabled).toBe(false));
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(blockerOptions().disabled).toBe(true));
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    expect(within(rowOf("Missing Vendor")).queryByText("Unsaved")).toBeNull();
  });

  it("stops guarding the moment a save succeeds, before the list is re-read", async () => {
    let finishRefetch: (rules: ReviewRule[]) => void = () => {};
    api.listReviewAgents.mockReset();
    api.listReviewAgents.mockResolvedValueOnce(RULES).mockImplementationOnce(
      () =>
        new Promise<ReviewRule[]>((resolve) => {
          finishRefetch = resolve;
        }),
    );
    const onUnsavedChange = vi.fn();
    const user = userEvent.setup();
    renderSection({ onUnsavedChange });

    await openRule(user, "Missing Vendor");
    await user.click(screen.getByRole("switch", { name: "Enable Missing Vendor" }));
    await waitFor(() => expect(blockerOptions().disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateReviewAgent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.listReviewAgents).toHaveBeenCalledTimes(2));
    // The refetch is still in flight, and the saved edit is no longer "unsaved".
    await waitFor(() => expect(blockerOptions().disabled).toBe(true));
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);

    finishRefetch(
      RULES.map((entry) =>
        entry.key === "missing_vendor" ? { ...entry, enabled: false, version: 3 } : entry,
      ),
    );
    await waitFor(() =>
      expect(within(rowOf("Missing Vendor")).getByText("Off", { selector: "span" })).toBeVisible(),
    );
    expect(blockerOptions().disabled).toBe(true);
  });

  it("never holds a navigation that stays on this route", async () => {
    renderSection();
    await screen.findByRole("region", { name: "Inbox checks" });
    const { shouldBlockFn } = blockerOptions();

    const settings = { routeId: "/organization/$orgId/settings" };
    expect(shouldBlockFn({ current: settings, next: settings })).toBe(false);
    expect(shouldBlockFn({ current: settings, next: { routeId: "/inbox" } })).toBe(true);
  });

  it("asks in the page when a route change is held, not with window.confirm", async () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    blocker.resolver = { status: "blocked", proceed, reset };
    const user = userEvent.setup();
    renderSection();

    const prompt = await screen.findByRole("alertdialog");
    expect(prompt).toHaveTextContent(/unsaved review rule changes/i);
    await user.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(reset).toHaveBeenCalledTimes(1);
    await user.click(within(prompt).getByRole("button", { name: "Discard and leave" }));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
