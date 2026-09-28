import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import { InboxV2Pane } from "../../src/components/inbox-v2/InboxV2Pane";
import type { InboxV2ListItem } from "../../src/lib/inbox/v2/list";

/**
 * A vendor bill in the Inbox v2 reading pane, with the real Bills editor. The default rules block
 * a bill with no department and no location, and a note was the only way past them: the editor had
 * no fields for either. These pin that each line now has both pickers, fed from the item's own
 * department and location lists, and that what is picked is what the correction sends.
 */

const api = vi.hoisted(() => ({
  getInboxItem: vi.fn(),
  updateInboxCandidate: vi.fn(),
  resolveInboxFinding: vi.fn(),
  retryInboundEmailProcessing: vi.fn(),
  getDuplicateCase: vi.fn(),
  previewDuplicateResolution: vi.fn(),
  resolveDuplicateCase: vi.fn(),
  getInboxSettings: vi.fn(),
  getMappedAccounts: vi.fn(),
  getDocumentViewerData: vi.fn(),
  listParties: vi.fn(),
  createParty: vi.fn(),
}));
vi.mock("../../src/routes/api/-inbox", () => ({
  getInboxItem: api.getInboxItem,
  updateInboxCandidate: api.updateInboxCandidate,
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
// The pane mounts "Remember this?" after a save; its server functions are stubbed like the others.
vi.mock("../../src/routes/api/-inbox-memory", () => ({
  rememberCorrection: vi.fn(),
  previewMemoryScope: vi.fn(async () => ({ available: false, scope: "file_hash", reason: "" })),
  listMemories: vi.fn(async () => []),
  enableMemory: vi.fn(),
  disableMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));
vi.mock("../../src/routes/api/-parties", () => ({
  listParties: api.listParties,
  createParty: api.createParty,
}));
vi.mock("../../src/lib/use-permission", () => ({
  usePermission: () => ({ canAccess: true, isLoading: false }),
  useRole: () => ({ role: "admin", isLoading: false }),
}));
vi.mock("../../src/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "reviewer-1" } } }) },
}));
// Only the bill path is under test; the transaction editor has tests of its own.
vi.mock("../../src/components/transactions/editor/TransactionEditor", () => ({
  TransactionEditor: () => <div data-testid="transaction-editor" />,
}));

const EXPENSE = "11111111-1111-4111-8111-111111111111";
const PAYABLE = "33333333-3333-4333-8333-333333333333";
const VENDOR = "44444444-4444-4444-8444-444444444444";
const OPERATIONS = "55555555-5555-4555-8555-555555555555";
const SALES = "66666666-6666-4666-8666-666666666666";
const MAIN_OFFICE = "77777777-7777-4777-8777-777777777777";
const RETIRED = "88888888-8888-4888-8888-888888888888";

const ITEM: InboxV2ListItem = {
  id: "item-bill",
  title: "Paper Street Supply",
  state: "needs_information",
  createdAt: new Date(),
  candidateRevision: 3,
  lockVersion: 5,
  who: "Paper Street Supply",
  kind: "vendor_bill",
  transactionDate: "2026-09-01",
  originalTotal: "42.10000000",
  originalCurrency: "USD",
  reason: "needs_fix",
  reasonDetail: "blocking_finding",
  reasonText: "Assign a department to this transaction.",
  sourceBadge: null,
};

function blocking(ruleKey: string, message: string) {
  return {
    id: `finding-${ruleKey}`,
    ruleKey,
    impact: "blocking",
    state: "open",
    message,
    evidence: {},
  };
}

function billDetail(expenseLine: { departmentId?: string | null } = {}) {
  return {
    item: {
      id: ITEM.id,
      state: ITEM.state,
      candidateRevision: ITEM.candidateRevision,
      lockVersion: ITEM.lockVersion,
      submittedBy: "submitter-1",
    },
    candidate: {
      id: "candidate-bill",
      candidateType: "bill",
      transactionType: "journal",
      transactionDate: "2026-09-01",
      memo: "Toner",
      referenceNumber: "PSS-19",
      partyId: VENDOR,
      originalCurrency: "USD",
      functionalCurrency: "USD",
      exchangeRate: "1.0000000000",
      originalTotal: "42.10000000",
      revision: ITEM.candidateRevision,
    },
    lines: [
      {
        id: "bill-e",
        accountId: EXPENSE,
        originalDebit: "42.10000000",
        originalCredit: null,
        lineDescription: "Toner cartridges",
        departmentId: expenseLine.departmentId ?? null,
        locationId: null,
      },
      {
        id: "bill-ap",
        accountId: PAYABLE,
        originalDebit: null,
        originalCredit: "42.10000000",
        lineDescription: "A/P: PSS-19",
        departmentId: null,
        locationId: null,
      },
    ],
    findings: [
      blocking("missing_department", "Assign a department to this transaction."),
      blocking("missing_location", "Assign a location to this transaction."),
    ],
    decisions: [],
    documents: [],
    duplicateCases: [],
    accountOptions: [
      { id: EXPENSE, accountNumber: "61000", name: "Office Supplies", accountType: "expense" },
      { id: PAYABLE, accountNumber: "21000", name: "Accounts Payable", accountType: "liability" },
    ],
    partyOptions: [],
    departmentOptions: [
      { id: OPERATIONS, name: "Operations", dimensionType: "department" },
      { id: SALES, name: "Sales", dimensionType: "department" },
    ],
    locationOptions: [{ id: MAIN_OFFICE, name: "Main Office", dimensionType: "location" }],
    economicEvent: {
      economicEventClass: "bill_accrual",
      direction: "outflow",
      reviewerEditable: false,
    },
    source: null,
    submitterName: "Sam Submitter",
    partyName: "Paper Street Supply",
  };
}

function renderPane() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <ToastProvider>
        <InboxV2Pane item={ITEM} onApprove={vi.fn()} onReject={vi.fn()} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const picker = (name: string) => screen.getByRole("combobox", { name });

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView ??= vi.fn();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /min-width:\s*(640|768|1024)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
  api.getInboxItem.mockResolvedValue(billDetail());
  api.getInboxSettings.mockResolvedValue({
    requireDifferentApprover: false,
    allowOwnerOverride: true,
  });
  api.getMappedAccounts.mockResolvedValue({ accounts_payable: PAYABLE, default_expense: EXPENSE });
  api.listParties.mockResolvedValue([
    { id: VENDOR, name: "Paper Street Supply", partyType: "vendor", email: null },
  ]);
  api.updateInboxCandidate.mockResolvedValue({
    inboxItem: { id: ITEM.id, lockVersion: 6 },
    candidateId: "candidate-bill",
    candidateRevision: 4,
    findingCount: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a vendor bill in the Inbox v2 reading pane", { timeout: 30_000 }, () => {
  it("picks a department and location per line and saves them onto the expense line", async () => {
    const user = userEvent.setup();
    renderPane();
    expect(
      await screen.findByRole("heading", { name: "Bill from Paper Street Supply" }),
    ).toBeInTheDocument();
    // One pair per bill line: the payable side is not a bill line and gets none.
    expect(
      screen.getAllByRole("combobox", { name: /^(Department|Location) for line/ }),
    ).toHaveLength(2);

    await user.click(picker("Department for line 1"));
    // The item's own active departments, as the classic Inbox listed them.
    expect(await screen.findByRole("option", { name: "Sales" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Operations" }));
    await user.click(picker("Location for line 1"));
    await user.click(await screen.findByRole("option", { name: "Main Office" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save & run checks" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Save & run checks" }));

    await waitFor(() => expect(api.updateInboxCandidate).toHaveBeenCalledTimes(1));
    const { data } = api.updateInboxCandidate.mock.calls[0][0];
    expect(data).toMatchObject({
      inboxItemId: ITEM.id,
      expectedRevision: 3,
      expectedLockVersion: 5,
      economicEventClass: "bill_accrual",
      partyId: VENDOR,
    });
    expect(data.lines).toEqual([
      {
        accountId: EXPENSE,
        debit: "42.1",
        credit: null,
        lineDescription: "Toner cartridges",
        departmentId: OPERATIONS,
        locationId: MAIN_OFFICE,
      },
      {
        accountId: PAYABLE,
        debit: null,
        credit: "42.1",
        lineDescription: "A/P: PSS-19",
        departmentId: null,
        locationId: null,
      },
    ]);
  });

  it("shows a line's department that is no longer active instead of showing it as none", async () => {
    api.getInboxItem.mockResolvedValue(billDetail({ departmentId: RETIRED }));
    renderPane();
    await screen.findByRole("heading", { name: "Bill from Paper Street Supply" });
    expect(picker("Department for line 1")).toHaveTextContent("Inactive department");
    expect(picker("Location for line 1")).toHaveTextContent("Location");
  });
});
