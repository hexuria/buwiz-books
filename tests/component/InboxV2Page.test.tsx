import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import { InboxV2Page } from "../../src/components/inbox-v2/InboxV2Page";
import type { InboxV2ListItem } from "../../src/lib/inbox/v2/list";

/**
 * Inbox v2 page behavior with the server functions mocked, so each assertion is on exactly what
 * would be sent. The two editors are stood in for by a small fake that honors the same handle
 * (getDraft / isDirty / focus): these tests are about the list, the strip, the keyboard and the
 * decision flow, and the real editors have tests of their own.
 */

const api = vi.hoisted(() => ({
  listInboxV2: vi.fn(),
  getInboxItem: vi.fn(),
  updateInboxCandidate: vi.fn(),
  approveInbox: vi.fn(),
  rejectInbox: vi.fn(),
  resolveInboxFinding: vi.fn(),
  retryInboundEmailProcessing: vi.fn(),
  getDuplicateCase: vi.fn(),
  previewDuplicateResolution: vi.fn(),
  resolveDuplicateCase: vi.fn(),
  getInboxSettings: vi.fn(),
  getMappedAccounts: vi.fn(),
  getDocumentViewerData: vi.fn(),
}));
vi.mock("../../src/routes/api/-inbox-v2", () => ({
  listInboxV2: api.listInboxV2,
}));
vi.mock("../../src/routes/api/-inbox", () => ({
  getInboxItem: api.getInboxItem,
  updateInboxCandidate: api.updateInboxCandidate,
  approveInbox: api.approveInbox,
  rejectInbox: api.rejectInbox,
  resolveInboxFinding: api.resolveInboxFinding,
  retryInboundEmailProcessing: api.retryInboundEmailProcessing,
  getDuplicateCase: api.getDuplicateCase,
  previewDuplicateResolution: api.previewDuplicateResolution,
  resolveDuplicateCase: api.resolveDuplicateCase,
}));
vi.mock("../../src/routes/api/-inbox-settings", () => ({ getInboxSettings: api.getInboxSettings }));
vi.mock("../../src/routes/api/-category-mappings", () => ({
  getMappedAccounts: api.getMappedAccounts,
}));
vi.mock("../../src/routes/api/-documents", () => ({
  getDocumentViewerData: api.getDocumentViewerData,
}));
const memoryApi = vi.hoisted(() => ({
  rememberCorrection: vi.fn(),
  previewMemoryScope: vi.fn(),
  listMemories: vi.fn(),
  enableMemory: vi.fn(),
  disableMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));
vi.mock("../../src/routes/api/-inbox-memory", () => memoryApi);

const access = vi.hoisted(() => ({ approve: true, reject: true, update: true, resolve: true }));
vi.mock("../../src/lib/use-permission", () => ({
  usePermission: (resource: string, action: string) => ({
    canAccess:
      resource === "inbox" && action === "approve"
        ? access.approve
        : resource === "inbox" && action === "reject"
          ? access.reject
          : resource === "inbox" && action === "update"
            ? access.update
            : access.resolve,
    isLoading: false,
  }),
  useRole: () => ({ role: "admin", isLoading: false }),
}));
vi.mock("../../src/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "reviewer-1" } } }) },
}));

const editor = vi.hoisted(() => ({
  dirty: false,
  rendered: [] as string[],
  /** What the reviewer changed, applied to the draft the editor hands back. */
  edit: null as null | ((draft: any) => any),
}));
vi.mock("../../src/components/bills/BillEditor", async () => {
  const { useImperativeHandle, useRef } = await import("react");
  function BillEditor({ draft, ref }: { draft: unknown; ref?: React.Ref<unknown> }) {
    const input = useRef<HTMLInputElement>(null);
    editor.rendered.push("bill");
    useImperativeHandle(ref, () => ({
      getDraft: () => draft,
      isDirty: () => editor.dirty,
      focus: () => input.current?.focus(),
    }));
    return (
      <div data-testid="bill-editor">
        <input ref={input} aria-label="Bill vendor" />
      </div>
    );
  }
  return { BillEditor };
});
vi.mock("../../src/components/transactions/editor/TransactionEditor", async () => {
  const { useImperativeHandle, useRef } = await import("react");
  function TransactionEditor({
    draft,
    onSubmit,
    ref,
  }: {
    draft: unknown;
    onSubmit?: (draft: unknown) => void;
    ref?: React.Ref<unknown>;
  }) {
    const input = useRef<HTMLInputElement>(null);
    editor.rendered.push("transaction");
    const current = () => (editor.edit ? editor.edit(draft) : draft);
    useImperativeHandle(ref, () => ({
      getDraft: current,
      validate: () => true,
      isDirty: () => editor.dirty,
      focus: () => input.current?.focus(),
    }));
    return (
      <div data-testid="transaction-editor">
        <input ref={input} aria-label="Transaction memo" />
        <button type="button" onClick={() => onSubmit?.(current())}>
          Save
        </button>
      </div>
    );
  }
  return { TransactionEditor };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const EXPENSE = "11111111-1111-4111-8111-111111111111";
const BANK = "22222222-2222-4222-8222-222222222222";
const PAYABLE = "33333333-3333-4333-8333-333333333333";
const VENDOR = "44444444-4444-4444-8444-444444444444";

function listItem(
  id: string,
  who: string,
  reason: InboxV2ListItem["reason"],
  overrides: Partial<InboxV2ListItem> = {},
): InboxV2ListItem {
  return {
    id,
    title: who,
    state: "ready_for_review",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    candidateRevision: 1,
    lockVersion: 1,
    who,
    kind: "expense",
    transactionDate: "2026-09-01",
    originalTotal: "42.10000000",
    originalCurrency: "USD",
    reason,
    reasonDetail:
      reason === "needs_fix"
        ? "blocking_finding"
        : reason === "jev_unsure"
          ? "low_confidence"
          : reason === "failed"
            ? "processing_failed"
            : "ready",
    reasonText: `${who} reason`,
    sourceBadge: null,
    ...overrides,
  };
}

const FIX = listItem("item-fix", "Ace Hardware", "needs_fix", {
  reasonText: "Assign a vendor to this expense transaction.",
});
const UNSURE_A = listItem("item-unsure-a", "Blue Bottle", "jev_unsure", {
  sourceBadge: { kind: "jev", confidence: 0.62 },
});
const UNSURE_B = listItem("item-unsure-b", "Cafe Nero", "jev_unsure", {
  sourceBadge: { kind: "remembered" },
});
const FAILED = listItem("item-failed", "Scanned PDF", "failed", { state: "failed" });
// Typed by hand, nothing open: ready to approve, not "Jev unsure".
const READY = listItem("item-ready", "Dunder Paper", "ready", {
  reasonText: "No check blocks it. Review the entry and approve it.",
});
const ALL_ITEMS = [FIX, UNSURE_A, UNSURE_B, FAILED, READY];

function detailFor(item: InboxV2ListItem, overrides: Record<string, unknown> = {}) {
  return {
    item: {
      id: item.id,
      state: item.state,
      candidateRevision: item.candidateRevision,
      lockVersion: item.lockVersion,
      submittedBy: "submitter-1",
    },
    candidate: {
      id: `candidate-${item.id}`,
      candidateType: "transaction",
      transactionType: "pay_out",
      transactionDate: "2026-09-01",
      memo: `${item.who} memo`,
      referenceNumber: "REF-1",
      partyId: VENDOR,
      originalCurrency: "USD",
      functionalCurrency: "USD",
      exchangeRate: "1.0000000000",
      originalTotal: "42.10000000",
      revision: item.candidateRevision,
    },
    lines: [
      {
        id: `${item.id}-e`,
        accountId: EXPENSE,
        originalDebit: "42.10000000",
        originalCredit: null,
        lineDescription: null,
        departmentId: null,
        locationId: null,
      },
      {
        id: `${item.id}-b`,
        accountId: BANK,
        originalDebit: null,
        originalCredit: "42.10000000",
        lineDescription: null,
        departmentId: null,
        locationId: null,
      },
    ],
    findings: [],
    decisions: [],
    documents: [],
    duplicateCases: [],
    accountOptions: [
      { id: EXPENSE, accountNumber: "61000", name: "Office Supplies", accountType: "expense" },
      { id: BANK, accountNumber: "10000", name: "Operating Bank", accountType: "asset" },
    ],
    partyOptions: [],
    departmentOptions: [],
    locationOptions: [],
    economicEvent: {
      economicEventClass: "purchase",
      direction: "outflow",
      reviewerEditable: false,
    },
    source: null,
    submitterName: "Sam Submitter",
    partyName: item.who,
    ...overrides,
  };
}

const BLOCKING_FINDING = {
  id: "finding-1",
  ruleKey: "missing_vendor",
  impact: "blocking",
  state: "open",
  message: "Assign a vendor to this expense transaction.",
  evidence: {},
};

// ── Harness ─────────────────────────────────────────────────────────────────

function setViewport(desktop: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: desktop && /min-width:\s*(1024|768|640)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
}

const selections: Array<string | undefined> = [];

function Harness({ initialSelected }: { initialSelected?: string }) {
  const [selected, setSelected] = useState(initialSelected);
  return (
    <InboxV2Page
      selectedId={selected}
      onSelect={(id) => {
        selections.push(id);
        setSelected(id);
      }}
    />
  );
}

function renderInbox(initialSelected?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Harness initialSelected={initialSelected} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient, invalidate };
}

function rows() {
  const list = screen.queryByRole("list", { name: "Items that need you" });
  return list ? within(list).getAllByRole("button") : [];
}

function activeRowText() {
  return rows().find((row) => row.getAttribute("aria-current") === "true")?.textContent ?? null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  selections.length = 0;
  editor.dirty = false;
  editor.rendered = [];
  editor.edit = null;
  memoryApi.previewMemoryScope.mockResolvedValue({
    available: true,
    scope: "file_hash",
    keyLabel: "File receipt.pdf",
    requiresAdmin: false,
    allowed: true,
    turnedOffNeedsAdmin: false,
    matched: 2,
    changed: 1,
    examined: 12,
    capped: false,
    windowMonths: 12,
    existingMemory: null,
  });
  Object.assign(access, { approve: true, reject: true, update: true, resolve: true });
  setViewport(true);
  api.listInboxV2.mockResolvedValue({ items: ALL_ITEMS, truncated: false, beingRead: 0 });
  api.getInboxItem.mockImplementation(({ data }: { data: { id: string } }) => {
    const item = ALL_ITEMS.find((entry) => entry.id === data.id)!;
    return Promise.resolve(detailFor(item));
  });
  api.getInboxSettings.mockResolvedValue({
    requireDifferentApprover: false,
    allowOwnerOverride: true,
  });
  api.getMappedAccounts.mockResolvedValue({ accounts_payable: PAYABLE, default_expense: EXPENSE });
  api.approveInbox.mockResolvedValue({
    approvalOutcome: "approved",
    journalHeaderId: "journal-1",
    transactionNumber: "TX-0042",
    alreadyApproved: false,
  });
  api.rejectInbox.mockResolvedValue({ rejected: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Inbox v2 list", { timeout: 30_000 }, () => {
  it("shows who, kind, relative date, amount and one reason chip per row", async () => {
    renderInbox();
    await screen.findByText("Ace Hardware");
    const first = rows()[0];
    expect(first).toHaveTextContent("Ace Hardware");
    expect(first).toHaveTextContent("Paid expense · 2 hours ago");
    expect(first).toHaveTextContent("$42.10");
    expect(within(first).getAllByText("Needs a fix")).toHaveLength(1);
    expect(screen.getByText("5 need you")).toBeInTheDocument();
  });

  it("filters by reason chip, with counts, and says when a filter is empty", async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText("Ace Hardware");
    const chips = screen.getByRole("toolbar", { name: "Filter by reason" });

    expect(within(chips).getByRole("button", { name: /All\s*5/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(chips).getByRole("button", { name: /Jev unsure\s*2/ }));
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Blue Bottle"),
      expect.stringContaining("Cafe Nero"),
    ]);

    await user.click(within(chips).getByRole("button", { name: /Failed\s*1/ }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Scanned PDF");

    await user.click(within(chips).getByRole("button", { name: /Ready to approve\s*1/ }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Dunder Paper");
    expect(within(rows()[0]).getByText("Ready to approve")).toBeInTheDocument();

    await user.click(within(chips).getByRole("button", { name: /Spot check\s*0/ }));
    expect(rows()).toHaveLength(0);
    expect(screen.getByText("No spot checks.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(rows()).toHaveLength(5);
  });

  it('says "Nothing needs you." when the list is empty', async () => {
    api.listInboxV2.mockResolvedValue({ items: [], truncated: false, beingRead: 0 });
    renderInbox();
    expect(await screen.findAllByText("Nothing needs you.")).not.toHaveLength(0);
    expect(rows()).toHaveLength(0);
    expect(screen.queryByText(/being read/)).not.toBeInTheDocument();
  });

  it("counts papers still being read in a quiet line, outside the list", async () => {
    api.listInboxV2.mockResolvedValue({ items: [FIX], truncated: false, beingRead: 3 });
    const { unmount } = renderInbox();
    expect(await screen.findByRole("status")).toHaveTextContent("3 papers being read");
    expect(rows()).toHaveLength(1);
    expect(screen.getByText("1 needs you")).toBeInTheDocument();
    unmount();

    api.listInboxV2.mockResolvedValue({ items: [], truncated: false, beingRead: 1 });
    renderInbox();
    expect(await screen.findByRole("status")).toHaveTextContent("1 paper being read");
    expect(screen.getAllByText("Nothing needs you.")).not.toHaveLength(0);
  });
});

describe("Inbox v2 keyboard", { timeout: 30_000 }, () => {
  it("moves with j and k, focuses the editor with e, and ignores keys while typing", async () => {
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText("Ace Hardware");
    await waitFor(() => expect(activeRowText()).toContain("Ace Hardware"));

    await user.keyboard("j");
    expect(activeRowText()).toContain("Blue Bottle");
    await user.keyboard("j");
    expect(activeRowText()).toContain("Cafe Nero");
    await user.keyboard("k");
    expect(activeRowText()).toContain("Blue Bottle");

    await screen.findByTestId("transaction-editor");
    await user.keyboard("e");
    const field = screen.getByLabelText("Transaction memo");
    expect(field).toHaveFocus();

    // Typing into the editor must not move, approve, or reject.
    await user.keyboard("jkar");
    expect(field).toHaveValue("jkar");
    expect(activeRowText()).toContain("Blue Bottle");
    expect(api.approveInbox).not.toHaveBeenCalled();
    expect(api.rejectInbox).not.toHaveBeenCalled();
  });

  it("rejects with r: asks why, then sends the reason through rejectInbox", async () => {
    const user = userEvent.setup();
    api.rejectInbox.mockImplementation(async () => {
      // The server no longer lists a rejected item.
      api.listInboxV2.mockResolvedValue({
        items: [UNSURE_A, UNSURE_B, FAILED, READY],
        truncated: false,
      });
      return { rejected: true };
    });
    renderInbox();
    await screen.findByTestId("transaction-editor");

    await user.keyboard("r");
    const why = screen.getByLabelText("Why reject it?");
    expect(why).toHaveFocus();
    await user.keyboard("Duplicate of last week's receipt{Enter}");

    await waitFor(() => expect(api.rejectInbox).toHaveBeenCalledTimes(1));
    expect(api.rejectInbox.mock.calls[0][0]).toEqual({
      data: {
        inboxItemId: FIX.id,
        expectedLockVersion: 1,
        reason: "Duplicate of last week's receipt",
      },
    });
    await waitFor(() => expect(screen.queryByText("Ace Hardware")).not.toBeInTheDocument());
    expect(activeRowText()).toContain("Blue Bottle");
    expect(await screen.findByText("Rejected. The paper stays in Documents.")).toBeInTheDocument();
  });
});

describe("Inbox v2 approval", { timeout: 30_000 }, () => {
  it("keeps Approve disabled, and a ignored, while a blocking finding is open", async () => {
    const user = userEvent.setup();
    api.getInboxItem.mockResolvedValue(detailFor(FIX, { findings: [BLOCKING_FINDING] }));
    renderInbox();
    await screen.findByTestId("transaction-editor");

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("title", "Fix or resolve the blocking check first.");
    // The check that blocks is listed with its message under the editor.
    expect(screen.getByText("Blocks approval")).toBeInTheDocument();
    expect(screen.getAllByText("Assign a vendor to this expense transaction.")).not.toHaveLength(0);

    await user.keyboard("a");
    expect(
      await screen.findByText("Fix or resolve the blocking check first.", {
        selector: "div *",
      }),
    ).toBeInTheDocument();
    expect(api.approveInbox).not.toHaveBeenCalled();
    expect(api.updateInboxCandidate).not.toHaveBeenCalled();
  });

  it("removes the row at once, moves to the next item, and invalidates the four caches", async () => {
    const user = userEvent.setup();
    const approval = deferred<unknown>();
    api.approveInbox.mockReturnValue(approval.promise);
    const { invalidate } = renderInbox();
    await screen.findByTestId("transaction-editor");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Approve" }));
    // Optimistic: gone before the server answers, and the next item is open.
    expect(screen.queryByText("Ace Hardware")).not.toBeInTheDocument();
    expect(activeRowText()).toContain("Blue Bottle");
    expect(api.approveInbox.mock.calls[0][0]).toEqual({
      data: {
        inboxItemId: FIX.id,
        expectedRevision: 1,
        expectedLockVersion: 1,
        overrideReason: undefined,
      },
    });

    api.listInboxV2.mockResolvedValue({
      items: [UNSURE_A, UNSURE_B, FAILED, READY],
      truncated: false,
    });
    await act(async () => {
      approval.resolve({
        approvalOutcome: "approved",
        journalHeaderId: "journal-1",
        transactionNumber: "TX-0042",
        alreadyApproved: false,
      });
    });
    expect(await screen.findByText("Approved as TX-0042.")).toBeInTheDocument();
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    for (const prefix of [["inbox"], ["bills"], ["transactions"], ["invoices"]]) {
      expect(invalidated).toContainEqual(prefix);
    }
    expect(screen.queryByText("Ace Hardware")).not.toBeInTheDocument();
  });

  it("puts the row back, reselects it, and shows the message when approval fails", async () => {
    const user = userEvent.setup();
    const approval = deferred<unknown>();
    api.approveInbox.mockReturnValue(approval.promise);
    renderInbox();
    await screen.findByTestId("transaction-editor");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());

    await user.keyboard("a");
    expect(screen.queryByText("Ace Hardware")).not.toBeInTheDocument();
    expect(activeRowText()).toContain("Blue Bottle");

    await act(async () => {
      approval.reject(new Error("This period is locked. Reopen it before approving."));
    });
    expect(
      await screen.findByText("This period is locked. Reopen it before approving."),
    ).toBeInTheDocument();
    expect(rows()[0]).toHaveTextContent("Ace Hardware");
    expect(activeRowText()).toContain("Ace Hardware");
    expect(selections.at(-1)).toBe(FIX.id);
  });

  it("saves unsaved edits through the candidate correction before approving", async () => {
    const user = userEvent.setup();
    editor.dirty = true;
    api.updateInboxCandidate.mockResolvedValue({
      inboxItem: { id: FIX.id, lockVersion: 2 },
      candidateId: `candidate-${FIX.id}`,
      candidateRevision: 2,
      findingCount: 0,
    });
    let revision = 1;
    api.getInboxItem.mockImplementation(() =>
      Promise.resolve(
        detailFor({ ...FIX, candidateRevision: revision, lockVersion: revision }, { findings: [] }),
      ),
    );
    api.updateInboxCandidate.mockImplementation(async () => {
      revision = 2;
      return {
        inboxItem: { id: FIX.id, lockVersion: 2 },
        candidateId: `candidate-${FIX.id}`,
        candidateRevision: 2,
        findingCount: 0,
      };
    });
    renderInbox();
    await screen.findByTestId("transaction-editor");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.approveInbox).toHaveBeenCalledTimes(1));

    expect(api.updateInboxCandidate).toHaveBeenCalledTimes(1);
    const correction = api.updateInboxCandidate.mock.calls[0][0].data;
    expect(correction).toMatchObject({
      inboxItemId: FIX.id,
      expectedRevision: 1,
      expectedLockVersion: 1,
      transactionType: "pay_out",
      transactionDate: "2026-09-01",
      partyId: VENDOR,
      originalCurrency: "USD",
      exchangeRate: "1",
    });
    expect(correction.lines).toEqual([
      expect.objectContaining({ accountId: BANK, credit: "42.1", debit: null }),
      expect.objectContaining({ accountId: EXPENSE, debit: "42.1", credit: null }),
    ]);
    // Approval uses the revision and lock the correction produced.
    expect(api.approveInbox.mock.calls[0][0].data).toMatchObject({
      inboxItemId: FIX.id,
      expectedRevision: 2,
      expectedLockVersion: 2,
    });
    expect(api.updateInboxCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      api.approveInbox.mock.invocationCallOrder[0],
    );
  });

  it("stops after saving when the re-run checks now block approval", async () => {
    const user = userEvent.setup();
    editor.dirty = true;
    let saved = false;
    api.getInboxItem.mockImplementation(() =>
      Promise.resolve(detailFor(FIX, saved ? { findings: [BLOCKING_FINDING] } : {})),
    );
    api.updateInboxCandidate.mockImplementation(async () => {
      saved = true;
      return {
        inboxItem: { id: FIX.id, lockVersion: 2 },
        candidateId: `candidate-${FIX.id}`,
        candidateRevision: 2,
        findingCount: 1,
      };
    });
    renderInbox();
    await screen.findByTestId("transaction-editor");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText("Saved, but a check still blocks approval: Vendor needed."),
    ).toBeInTheDocument();
    expect(api.approveInbox).not.toHaveBeenCalled();
    expect(rows()[0]).toHaveTextContent("Ace Hardware");
  });

  it("opens vendor bills in the Bills editor and other kinds in the transaction editor", async () => {
    const bill = listItem("item-bill", "Paper Street Supply", "jev_unsure", {
      kind: "vendor_bill",
    });
    api.listInboxV2.mockResolvedValue({ items: [bill, UNSURE_A], truncated: false });
    api.getInboxItem.mockImplementation(({ data }: { data: { id: string } }) =>
      Promise.resolve(
        data.id === bill.id
          ? detailFor(bill, {
              candidate: {
                ...detailFor(bill).candidate,
                candidateType: "bill",
                transactionType: "journal",
              },
              lines: [
                {
                  id: "bill-e",
                  accountId: EXPENSE,
                  originalDebit: "42.10000000",
                  originalCredit: null,
                  lineDescription: null,
                  departmentId: null,
                  locationId: null,
                },
                {
                  id: "bill-ap",
                  accountId: PAYABLE,
                  originalDebit: null,
                  originalCredit: "42.10000000",
                  lineDescription: "A/P: REF-1",
                  departmentId: null,
                  locationId: null,
                },
              ],
              economicEvent: {
                economicEventClass: "bill_accrual",
                direction: "outflow",
                reviewerEditable: false,
              },
            })
          : detailFor(UNSURE_A),
      ),
    );
    const user = userEvent.setup();
    renderInbox();
    expect(await screen.findByTestId("bill-editor")).toBeInTheDocument();
    expect(screen.getByText("Vendor bill")).toBeInTheDocument();
    await user.keyboard("j");
    expect(await screen.findByTestId("transaction-editor")).toBeInTheDocument();
  });

  it("shows the source badge and a duplicate warning in the strip", async () => {
    api.getInboxItem.mockImplementation(({ data }: { data: { id: string } }) =>
      Promise.resolve(
        detailFor(data.id === UNSURE_A.id ? UNSURE_A : FIX, {
          duplicateCases:
            data.id === UNSURE_A.id
              ? [
                  {
                    id: "case-1",
                    state: "open",
                    score: "88.00",
                    matchType: "semantic",
                    matchClass: "duplicate",
                    disposition: "blocking",
                    algorithmVersion: 4,
                    lockVersion: 1,
                    signals: {},
                    resolutionAction: null,
                    resolutionReason: null,
                    resolvedAt: null,
                  },
                ]
              : [],
        }),
      ),
    );
    api.getDuplicateCase.mockReturnValue(new Promise(() => {}));
    renderInbox(UNSURE_A.id);
    expect(await screen.findByText("Jev 62%")).toBeInTheDocument();
    expect(
      await screen.findByText(/Possible duplicate \(88\.00% match\)/, { selector: "p" }),
    ).toBeInTheDocument();
  });
});

describe("Inbox v2 on a phone", { timeout: 30_000 }, () => {
  it("opens the reading pane as a full-height drawer only when an item is picked", async () => {
    setViewport(false);
    const user = userEvent.setup();
    renderInbox();
    await screen.findByText("Ace Hardware");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(rows()[1]);
    const drawer = await screen.findByRole("dialog", { name: "Blue Bottle" });
    expect(within(drawer).getByRole("button", { name: "Approve" })).toBeInTheDocument();

    await user.click(within(drawer).getByRole("button", { name: "Back to Inbox" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Inbox v2 memory", { timeout: 30_000 }, () => {
  const OTHER_EXPENSE = "55555555-5555-4555-8555-555555555555";
  /** The reviewer books the paid-for line to another expense account. */
  const recategorize = (draft: any) => ({
    ...draft,
    payForLines: draft.payForLines.map((line: any) => ({ ...line, categoryId: OTHER_EXPENSE })),
  });
  const saved = {
    inboxItem: { id: FIX.id, lockVersion: 2 },
    candidateId: `candidate-${FIX.id}`,
    candidateRevision: 2,
    findingCount: 0,
    memory: { outcome: "none" },
  };

  it("offers Remember this? after a save that changed the answer", async () => {
    const user = userEvent.setup();
    editor.edit = recategorize;
    api.updateInboxCandidate.mockResolvedValue(saved);
    renderInbox();
    await screen.findByTestId("transaction-editor");

    await user.click(screen.getByRole("button", { name: "Save" }));
    const prompt = await screen.findByRole("region", { name: "Remember this?" });
    await waitFor(() =>
      expect(memoryApi.previewMemoryScope).toHaveBeenCalledWith({
        data: { candidateId: `candidate-${FIX.id}`, scope: "file_hash" },
      }),
    );
    expect(await within(prompt).findByTestId("memory-preview-count")).toHaveTextContent(
      "Would have changed 1 of 2 past papers",
    );
    // Non-blocking: approval stays available while it is open.
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();

    await user.click(within(prompt).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Remember this?" })).not.toBeInTheDocument();
  });

  it("offers nothing after a save that kept the answer", async () => {
    const user = userEvent.setup();
    api.updateInboxCandidate.mockResolvedValue(saved);
    renderInbox();
    await screen.findByTestId("transaction-editor");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^Saved\./u)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Remember this?" })).not.toBeInTheDocument();
    expect(memoryApi.previewMemoryScope).not.toHaveBeenCalled();
  });

  it("offers it once an approval that changed the answer lands, then gets out of the way", async () => {
    const user = userEvent.setup();
    editor.dirty = true;
    editor.edit = recategorize;
    let revision = 1;
    api.getInboxItem.mockImplementation(({ data }: { data: { id: string } }) => {
      const item = ALL_ITEMS.find((entry) => entry.id === data.id)!;
      return Promise.resolve(
        detailFor(
          data.id === FIX.id
            ? { ...FIX, candidateRevision: revision, lockVersion: revision }
            : item,
        ),
      );
    });
    api.updateInboxCandidate.mockImplementation(async () => {
      revision = 2;
      return saved;
    });
    renderInbox();
    await screen.findByTestId("transaction-editor");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.approveInbox).toHaveBeenCalledTimes(1));
    // The server never sees the offer.
    expect(api.approveInbox.mock.calls[0][0].data).not.toHaveProperty("remember");

    const offer = await screen.findByRole("complementary", {
      name: "Remember your last correction",
    });
    expect(
      within(offer).getByText("You corrected Ace Hardware before approving it."),
    ).toBeVisible();
    await waitFor(() =>
      expect(memoryApi.previewMemoryScope).toHaveBeenCalledWith({
        data: { candidateId: `candidate-${FIX.id}`, scope: "file_hash" },
      }),
    );
    await user.click(within(offer).getByRole("button", { name: "Not now" }));
    expect(
      screen.queryByRole("complementary", { name: "Remember your last correction" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer it to a reviewer who cannot approve", async () => {
    const user = userEvent.setup();
    access.approve = false;
    editor.edit = recategorize;
    api.updateInboxCandidate.mockResolvedValue(saved);
    renderInbox();
    await screen.findByTestId("transaction-editor");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^Saved\./u)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Remember this?" })).not.toBeInTheDocument();
  });

  it("marks a memory-answered item Remembered in the strip", async () => {
    renderInbox(UNSURE_B.id);
    await screen.findByTestId("transaction-editor");
    const badge = await screen.findByText("Remembered");
    expect(badge).toHaveAttribute("title", "Answered from a correction you asked Jev to remember");
  });
});
