import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import { ReviewRulesSettings } from "../../src/components/settings/ReviewRulesSettings";
import type { ReviewRule } from "../../src/components/settings/ReviewRuleConfigForm";
import type { listReviewFindings, listReviewRuns } from "../../src/routes/api/-review-agents";

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
 *
 * The same section owns the ledger scan that replaced the Review Agents page's run button: it must
 * call the existing `runReviewAgents`, report its counts, and keep the findings list and its
 * resolve action.
 */

const api = vi.hoisted(() => ({
  listReviewAgents: vi.fn(),
  updateReviewAgent: vi.fn(),
  runReviewAgents: vi.fn(),
  listReviewFindings: vi.fn(),
  listReviewRuns: vi.fn(),
  resolveReviewFinding: vi.fn(),
}));
vi.mock("../../src/routes/api/-review-agents", () => api);

// The section closes with the rule snapshots card (RuleSnapshotsPanel).
const snapshotsApi = vi.hoisted(() => ({
  listRuleSnapshots: vi.fn(),
  createRuleSnapshot: vi.fn(),
  pinRoutineRuleSnapshot: vi.fn(),
  unpinRoutineRuleSnapshot: vi.fn(),
}));
vi.mock("../../src/routes/api/-rule-snapshots", () => snapshotsApi);
const routinesApi = vi.hoisted(() => ({ listRoutines: vi.fn() }));
vi.mock("../../src/routes/api/-routines", () => routinesApi);
const memoryApi = vi.hoisted(() => ({
  listMemories: vi.fn(),
  enableMemory: vi.fn(),
  disableMemory: vi.fn(),
  deleteMemory: vi.fn(),
  rememberCorrection: vi.fn(),
  previewMemoryScope: vi.fn(),
}));
vi.mock("../../src/routes/api/-inbox-memory", () => memoryApi);

const permission = vi.hoisted(() => ({
  configure: true,
  run: true,
  resolve: true,
  // While the role loads, the real hook reports canAccess: false, isLoading: true.
  loading: false,
}));
vi.mock("../../src/lib/use-permission", () => ({
  usePermission: (resource: string, action: string) => ({
    canAccess: permission.loading
      ? false
      : resource === "agentRule" && action === "configure"
        ? permission.configure
        : resource === "agentRule" && action === "run"
          ? permission.run
          : resource === "review" && action === "resolve"
            ? permission.resolve
            : true,
    isLoading: permission.loading,
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
// There is no router in jsdom: the blocker records its options and links render as anchors.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useBlocker: (options: BlockerOptions) => {
    blocker.calls.push(options);
    return blocker.resolver;
  },
  Link: ({
    children,
    to,
    params,
    search,
    ...rest
  }: {
    children?: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    className?: string;
  }) => {
    const path = Object.entries(params ?? {}).reduce(
      (href, [key, value]) => href.replace(`$${key}`, value),
      to,
    );
    const query = new URLSearchParams(search ?? {}).toString();
    return (
      <a href={query ? `${path}?${query}` : path} {...rest}>
        {children}
      </a>
    );
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

const MATERIAL_EXPENSE = rule({
  definitionId: "00000000-0000-4000-8000-000000000005",
  key: "material_expense",
  name: "Material Expense",
  group: "review",
  configJson: JSON.stringify({ annualizedExpensePercent: 1 }),
  openFindingCount: 1,
  lastRunAt: new Date("2026-09-01T10:00:00.000Z"),
  version: 1,
});

const RULES = [MISSING_VENDOR, DUPLICATE, UNUSUAL_SPEND, MATERIAL_EXPENSE, SOURCE_FAILED];

type Finding = Awaited<ReturnType<typeof listReviewFindings>>["findings"][number];

const LEDGER_FINDING: Finding = {
  id: "00000000-0000-4000-8000-0000000000f1",
  ruleKey: "material_expense",
  impact: "warning",
  state: "open",
  subjectType: "journal_header",
  subjectId: "00000000-0000-4000-8000-0000000000a1",
  message: "Material expense: 12,500.00 is above the 1% threshold.",
  evidence: { threshold: "9800.00" },
  firstSeenAt: new Date("2026-09-01T10:00:00.000Z"),
  lastSeenAt: new Date("2026-09-01T10:00:00.000Z"),
  resolvedAt: null,
  resolutionNote: null,
  inboxItemId: null,
  resolvableHere: true,
  subjectLabel: "JE-0042",
  subjectSublabel: "Server rack",
  subjectDate: "2026-08-14",
  subjectAmount: "12500.00000000",
  subjectCurrency: "USD",
};

const INBOX_BOUND_FINDING: Finding = {
  ...LEDGER_FINDING,
  id: "00000000-0000-4000-8000-0000000000f2",
  message: "Posted to a parent category.",
  inboxItemId: "00000000-0000-4000-8000-0000000000b1",
  resolvableHere: false,
};

type Run = Awaited<ReturnType<typeof listReviewRuns>>[number];

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    status: "completed",
    trigger: "manual",
    windowStart: "2026-09-01",
    windowEnd: "2026-09-30",
    asOfDate: "2026-09-30",
    counts: { scanned: 12, findings: 0 },
    lastError: null,
    startedAt: new Date("2026-09-30T08:00:00.000Z"),
    completedAt: new Date("2026-09-30T08:00:02.000Z"),
    ...overrides,
  };
}

type SectionProps = { focusRuleKey?: string; onUnsavedChange?: (unsaved: boolean) => void };

function renderSection(props: SectionProps = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (next: SectionProps) => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ReviewRulesSettings {...next} />
      </ToastProvider>
    </QueryClientProvider>
  );
  const view = render(tree(props));
  // Same page, new search: what Settings does when a second Inbox link arrives while it is open.
  return { ...view, rerenderWith: (next: SectionProps) => view.rerender(tree(next)) };
}

function rowOf(name: string) {
  return screen.getByText(name, { selector: "p" }).closest("li")!;
}

async function openRule(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: `Edit ${name}` }));
}

const BASELINE_SNAPSHOT = {
  id: "00000000-0000-4000-8000-0000000000d1",
  label: "Baseline",
  createdBy: "user-1",
  createdAt: new Date("2026-09-01T08:00:00.000Z"),
  ruleCount: 14,
  pinnedBy: [{ routineId: "routine-email", routineName: "Inbound email", slot: "active" as const }],
};
const STRICT_SNAPSHOT = {
  ...BASELINE_SNAPSHOT,
  id: "00000000-0000-4000-8000-0000000000d2",
  label: "Receipts over 10",
  createdAt: new Date("2026-09-20T08:00:00.000Z"),
  pinnedBy: [],
};
const EMAIL_ROUTINE = {
  id: "routine-email",
  name: "Inbound email",
  ruleSnapshotId: BASELINE_SNAPSHOT.id,
  shadowRuleSnapshotId: null,
};

beforeEach(() => {
  snapshotsApi.listRuleSnapshots
    .mockReset()
    .mockResolvedValue([STRICT_SNAPSHOT, BASELINE_SNAPSHOT]);
  snapshotsApi.createRuleSnapshot.mockReset().mockResolvedValue({
    ...STRICT_SNAPSHOT,
    id: "00000000-0000-4000-8000-0000000000d3",
    label: "Stricter receipts",
    snapshot: [],
  });
  snapshotsApi.pinRoutineRuleSnapshot.mockReset().mockResolvedValue(EMAIL_ROUTINE);
  snapshotsApi.unpinRoutineRuleSnapshot.mockReset().mockResolvedValue(EMAIL_ROUTINE);
  routinesApi.listRoutines.mockReset().mockResolvedValue([EMAIL_ROUTINE]);
  memoryApi.listMemories.mockReset().mockResolvedValue([]);
  blocker.calls = [];
  blocker.resolver = { status: "idle" };
  permission.configure = true;
  permission.run = true;
  permission.resolve = true;
  permission.loading = false;
  api.listReviewAgents.mockReset().mockResolvedValue(RULES);
  api.listReviewRuns.mockReset().mockResolvedValue([]);
  api.listReviewFindings.mockReset().mockResolvedValue({ findings: [], nextCursor: null });
  api.runReviewAgents.mockReset();
  api.resolveReviewFinding.mockReset().mockResolvedValue({ alreadyResolved: false });
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

describe("ReviewRulesSettings — opened from an Inbox finding", () => {
  it("opens the linked rule's settings without a click", async () => {
    renderSection({ focusRuleKey: "missing_vendor" });

    expect(await screen.findByRole("switch", { name: "Enable Missing Vendor" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Missing Vendor" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // Only the linked rule.
    expect(screen.queryByRole("switch", { name: "Enable Unusual Spend" })).toBeNull();
  });

  it("opens a rule linked after Settings is already showing", async () => {
    const view = renderSection({ focusRuleKey: "missing_vendor" });
    expect(await screen.findByRole("switch", { name: "Enable Missing Vendor" })).toBeVisible();

    view.rerenderWith({ focusRuleKey: "unusual_spend" });

    expect(await screen.findByRole("switch", { name: "Enable Unusual Spend" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Unusual Spend" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // Rows open independently, so the earlier one stays as it was.
    expect(screen.getByRole("switch", { name: "Enable Missing Vendor" })).toBeVisible();
    // The ledger findings follow the link to that check.
    await waitFor(() =>
      expect(api.listReviewFindings).toHaveBeenCalledWith({
        data: { ruleKey: "unusual_spend", state: "open", limit: 50 },
      }),
    );
  });
});

describe("ReviewRulesSettings — Scan books", () => {
  it("runs the existing ledger scan and reports what ran, not a fetch window or a total", async () => {
    api.runReviewAgents.mockResolvedValue({
      asOfDate: "2026-09-30",
      // The fetch bound across every config, including Inbox checks the scan does not run.
      windowStart: "2026-07-01",
      rules: [
        { ruleKey: "unusual_spend", findingCount: 0 },
        { ruleKey: "material_expense", findingCount: 2 },
      ],
    });
    const user = userEvent.setup();
    renderSection();

    const scan = await screen.findByRole("region", { name: "Scan books" });
    await user.click(within(scan).getByRole("button", { name: "Scan books" }));

    await waitFor(() => expect(api.runReviewAgents).toHaveBeenCalledTimes(1));
    const [call] = api.runReviewAgents.mock.calls[0] as [{ data: { asOfDate: string } }];
    // Every enabled ledger check, not a subset: no ruleKeys.
    expect(call).toEqual({ data: { asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });

    const summary = await within(scan).findByRole("status");
    expect(summary).toHaveTextContent("Scan as of 2026-09-30 finished · 2 checks ran.");
    expect(summary).not.toHaveTextContent("2026-07-01");
    expect(summary).not.toHaveTextContent(/2 findings/);

    // Open counts and each check's own run row are re-read after a scan.
    await waitFor(() => expect(api.listReviewAgents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        api.listReviewRuns.mock.calls.filter(
          ([input]) => (input as { data: { ruleKey: string } }).data.ruleKey === "material_expense",
        ),
      ).toHaveLength(2),
    );
  });

  it("shows each check's own window and what it observed, apart from its Open count", async () => {
    api.listReviewRuns.mockImplementation(async ({ data }: { data: { ruleKey: string } }) =>
      data.ruleKey === "unusual_spend"
        ? [run({ windowStart: "2026-04-01", counts: { scanned: 40, findings: 2 } })]
        : [
            run({
              status: "running",
              windowStart: "2026-09-01",
              completedAt: null,
              // Left running by a request that died two hours ago.
              startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
            }),
          ],
    );
    renderSection();

    const runs = await screen.findByRole("list", { name: "Ledger check runs" });
    expect(api.listReviewRuns).toHaveBeenCalledWith({
      data: { ruleKey: "unusual_spend", limit: 1 },
    });
    const spend = within(runs)
      .getByRole("button", { name: "Unusual Spend, 0 open" })
      .closest("li")!;
    expect(await within(spend).findByText(/2026-04-01 → 2026-09-30/)).toBeVisible();
    expect(spend).toHaveTextContent("2 observed this run");
    expect(spend).toHaveTextContent(/Last run/);

    const expense = within(runs)
      .getByRole("button", { name: "Material Expense, 1 open" })
      .closest("li")!;
    expect(await within(expense).findByText(/Did not finish/)).toBeVisible();
    expect(expense).not.toHaveTextContent("observed this run");
  });

  it("shows a run still in progress, a failed run, and its error", async () => {
    api.listReviewRuns.mockImplementation(async ({ data }: { data: { ruleKey: string } }) =>
      data.ruleKey === "unusual_spend"
        ? [run({ status: "running", completedAt: null, startedAt: new Date() })]
        : [run({ status: "failed", completedAt: null, lastError: "Ledger read timed out." })],
    );
    renderSection();

    const runs = await screen.findByRole("list", { name: "Ledger check runs" });
    expect(await within(runs).findByText(/Running · started/)).toBeVisible();
    expect(within(runs).queryByText(/Did not finish/)).toBeNull();
    expect(await within(runs).findByText(/Failed ·/)).toBeVisible();
    expect(within(runs).getByText("Ledger read timed out.")).toBeVisible();
  });

  it("waits for the role before saying scanning or resolving is not allowed", async () => {
    permission.loading = true;
    api.listReviewFindings.mockResolvedValue({ findings: [LEDGER_FINDING], nextCursor: null });
    renderSection();

    const scan = await screen.findByRole("region", { name: "Scan books" });
    const list = await within(scan).findByRole("list", { name: "Material Expense findings" });
    expect(within(scan).queryByRole("button", { name: "Scan books" })).toBeNull();
    expect(scan).not.toHaveTextContent(/requires the “run agent rules” permission/);
    expect(within(list).queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(list).not.toHaveTextContent(/needs the “resolve review findings” permission/);
  });

  it("says resolving needs the review permission when the role lacks it", async () => {
    permission.resolve = false;
    api.listReviewFindings.mockResolvedValue({ findings: [LEDGER_FINDING], nextCursor: null });
    renderSection();

    const list = await screen.findByRole("list", { name: "Material Expense findings" });
    expect(list).toHaveTextContent(
      "Resolving this finding needs the “resolve review findings” permission.",
    );
    expect(within(list).queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("is not offered without the run permission", async () => {
    permission.run = false;
    renderSection();

    const scan = await screen.findByRole("region", { name: "Scan books" });
    expect(within(scan).queryByRole("button", { name: "Scan books" })).toBeNull();
    expect(scan).toHaveTextContent(/requires the “run agent rules” permission/);
  });

  it("lists a check's ledger findings and resolves one with a note", async () => {
    api.listReviewFindings.mockImplementation(async ({ data }: { data: { ruleKey: string } }) =>
      data.ruleKey === "material_expense"
        ? { findings: [LEDGER_FINDING], nextCursor: null }
        : { findings: [], nextCursor: null },
    );
    const user = userEvent.setup();
    renderSection();

    // The check with open findings is selected first.
    const list = await screen.findByRole("list", { name: "Material Expense findings" });
    expect(api.listReviewFindings).toHaveBeenCalledWith({
      data: { ruleKey: "material_expense", state: "open", limit: 50 },
    });
    expect(within(list).getByText(LEDGER_FINDING.message)).toBeVisible();
    expect(within(list).getByRole("link", { name: /JE-0042/ })).toHaveAttribute(
      "href",
      `/transactions/${LEDGER_FINDING.subjectId}`,
    );

    const resolve = within(list).getByRole("button", { name: "Resolve" });
    expect(resolve).toBeDisabled();
    await user.type(
      within(list).getByRole("textbox", { name: `Resolution note for ${LEDGER_FINDING.message}` }),
      "Approved capital purchase",
    );
    await user.click(resolve);

    await waitFor(() =>
      expect(api.resolveReviewFinding).toHaveBeenCalledWith({
        data: { findingId: LEDGER_FINDING.id, resolutionNote: "Approved capital purchase" },
      }),
    );
  });

  it("sends an Inbox-bound finding to the Inbox instead of resolving it here", async () => {
    api.listReviewFindings.mockResolvedValue({ findings: [INBOX_BOUND_FINDING], nextCursor: null });
    renderSection();

    const list = await screen.findByRole("list", { name: "Material Expense findings" });
    expect(within(list).queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(within(list).getByRole("link", { name: /Open in Inbox/ })).toHaveAttribute(
      "href",
      `/inbox?selected=${INBOX_BOUND_FINDING.inboxItemId}`,
    );
  });

  it("switches checks and between open and all findings", async () => {
    const user = userEvent.setup();
    renderSection();

    const scan = await screen.findByRole("region", { name: "Scan books" });
    await user.click(within(scan).getByRole("button", { name: "Unusual Spend, 0 open" }));
    await waitFor(() =>
      expect(api.listReviewFindings).toHaveBeenCalledWith({
        data: { ruleKey: "unusual_spend", state: "open", limit: 50 },
      }),
    );
    await user.click(within(scan).getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(api.listReviewFindings).toHaveBeenCalledWith({
        data: { ruleKey: "unusual_spend", state: "all", limit: 50 },
      }),
    );
    expect(await within(scan).findByText("Not scanned yet")).toBeVisible();
  });
});

describe("ReviewRulesSettings — rule snapshots", () => {
  it("closes the section with the saved snapshots and each routine's rules", async () => {
    renderSection();

    const card = await screen.findByRole("region", { name: "Rule snapshots" });
    const list = await within(card).findByRole("list", { name: "Saved rule snapshots" });
    expect(within(list).getByText("Baseline")).toBeVisible();
    expect(within(list).getByText("Receipts over 10")).toBeVisible();
    expect(within(list).getByText("Pinned on Inbound email")).toBeVisible();
    expect(within(card).getByLabelText("Rules for Inbound email")).toHaveValue(
      BASELINE_SNAPSHOT.id,
    );
    expect(within(card).getByLabelText("Shadow for Inbound email")).toHaveValue("");
    // After the rule groups, so it reads as a snapshot of everything above.
    const inbox = screen.getByRole("region", { name: "Inbox checks" });
    expect(inbox.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("snapshots the current rules and pins through the server functions", async () => {
    const user = userEvent.setup();
    renderSection();
    const card = await screen.findByRole("region", { name: "Rule snapshots" });

    await user.type(within(card).getByLabelText("Snapshot label"), "Stricter receipts");
    await user.click(within(card).getByRole("button", { name: "Snapshot current rules" }));
    await waitFor(() =>
      expect(snapshotsApi.createRuleSnapshot).toHaveBeenCalledWith({
        data: { label: "Stricter receipts" },
      }),
    );
    expect(await screen.findByText("Snapshot “Stricter receipts” saved.")).toBeVisible();

    await user.selectOptions(
      within(card).getByLabelText("Shadow for Inbound email"),
      STRICT_SNAPSHOT.id,
    );
    await waitFor(() =>
      expect(snapshotsApi.pinRoutineRuleSnapshot).toHaveBeenCalledWith({
        data: { routineId: "routine-email", snapshotId: STRICT_SNAPSHOT.id, shadow: true },
      }),
    );
    await user.selectOptions(within(card).getByLabelText("Rules for Inbound email"), "");
    await waitFor(() =>
      expect(snapshotsApi.unpinRoutineRuleSnapshot).toHaveBeenCalledWith({
        data: { routineId: "routine-email", shadow: false },
      }),
    );
    expect((await screen.findAllByText("Inbound email rules updated.")).length).toBeGreaterThan(0);
  });

  it("is read-only without the configure permission", async () => {
    permission.configure = false;
    renderSection();
    const card = await screen.findByRole("region", { name: "Rule snapshots" });
    expect(within(card).getByRole("button", { name: "Snapshot current rules" })).toBeDisabled();
    expect(await within(card).findByLabelText("Rules for Inbound email")).toBeDisabled();
  });
});

describe("ReviewRulesSettings — memories", () => {
  it("closes the section with the Inbox's memories, after the snapshots", async () => {
    memoryApi.listMemories.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-00000000me01",
        matchKind: "party",
        keyLabel: "Staples",
        enabled: true,
        autoDisabled: false,
        uses: 4,
        undos: 0,
        consecutiveUndos: 0,
        answer: {
          docKind: "purchase",
          party: { id: "00000000-0000-4000-8000-00000000pa01", name: "Staples" },
          lines: [
            { side: "debit", accountId: "a1", accountLabel: "67200 · Office Supplies" },
            { side: "credit", accountId: "a2", accountLabel: "11000 · Bank Accounts" },
          ],
        },
        problem: null,
        createdBy: { id: "u1", name: "Maria Santos" },
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:00:00.000Z",
      },
    ]);
    renderSection();

    const card = await screen.findByRole("region", { name: "Memories" });
    expect(await within(card).findByText("Paid expense · Staples")).toBeVisible();
    expect(memoryApi.listMemories).toHaveBeenCalled();
    const snapshots = screen.getByRole("region", { name: "Rule snapshots" });
    expect(snapshots.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
