import React, { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import {
  BillEditor,
  type BillDraft,
  type BillEditorHandle,
} from "../../src/components/bills/BillEditor";
import {
  TransactionEditor,
  type TransactionEditorHandle,
} from "../../src/components/transactions/editor/TransactionEditor";
import type { TransactionDraft } from "../../src/components/transactions/editor/transaction-draft";

/**
 * The extracted editors as the Inbox reading pane uses them: seeded from a draft, handing edits
 * back through onSubmit and a handle (getDraft / isDirty / focus), never saving or navigating on
 * their own. The routes' own tests pin the page behavior; these pin the pane's contract.
 */

const api = vi.hoisted(() => ({
  listParties: vi.fn(),
  createParty: vi.fn(),
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  suggestParties: vi.fn(),
  listDepartments: vi.fn(),
  listLocations: vi.fn(),
  listPartyMappings: vi.fn(),
}));
vi.mock("../../src/routes/api/-parties", () => ({
  listParties: api.listParties,
  createParty: api.createParty,
}));
vi.mock("../../src/routes/api/-accounts", () => ({
  listAccounts: api.listAccounts,
  createAccount: api.createAccount,
}));
vi.mock("../../src/routes/api/-party-suggestions", () => ({ suggestParties: api.suggestParties }));
vi.mock("../../src/routes/api/-dimensions", () => ({
  listDepartments: api.listDepartments,
  listLocations: api.listLocations,
}));
vi.mock("../../src/routes/api/-party-mappings", () => ({
  listPartyMappings: api.listPartyMappings,
}));

const EXPENSE = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const BANK = "33333333-3333-4333-8333-333333333333";
const VENDOR = "44444444-4444-4444-8444-444444444444";

function wrap(children: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

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
  api.listParties.mockResolvedValue([
    { id: VENDOR, name: "Paper Street Supply", partyType: "vendor", email: null },
  ]);
  api.listAccounts.mockResolvedValue([
    {
      id: BANK,
      name: "Operating Bank",
      accountNumber: "1000",
      accountType: "asset",
      subtype: "checking",
      icon: null,
      parentId: null,
      children: [],
    },
    {
      id: EXPENSE,
      name: "Office Supplies",
      accountNumber: "6100",
      accountType: "expense",
      subtype: "office_supplies",
      icon: null,
      parentId: null,
      children: [],
    },
  ]);
  api.suggestParties.mockResolvedValue([]);
  api.listDepartments.mockResolvedValue([]);
  api.listLocations.mockResolvedValue([]);
  api.listPartyMappings.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BillEditor in the reading pane", { timeout: 30_000 }, () => {
  const draft: BillDraft = {
    vendorId: VENDOR,
    billNumber: "INV-7",
    billDate: "2026-09-01",
    dueDate: "2026-09-01",
    memo: "Office restock",
    lineItems: [
      {
        id: "l1",
        description: "Pens",
        amount: "12.50",
        accountId: EXPENSE,
        departmentId: "dept-1",
      },
      { id: "l2", description: "Prepaid", amount: "7.50", accountId: ASSET },
    ],
  };

  function renderBill(props: Partial<React.ComponentProps<typeof BillEditor>> = {}) {
    const ref = createRef<BillEditorHandle>();
    const onSubmit = vi.fn();
    render(
      wrap(
        <BillEditor
          ref={ref}
          draft={draft}
          onSubmit={onSubmit}
          categoryAccounts={[
            { id: EXPENSE, accountNumber: "6100", name: "Office Supplies" },
            // A line may already use a non-expense account; the pane passes it in so the line
            // never displays as something else.
            { id: ASSET, accountNumber: "1400", name: "Prepaid Expenses" },
          ]}
          submitLabel="Save & run checks"
          title="Bill from Paper Street Supply"
          headingLevel="h2"
          showDueDate={false}
          currency="PHP"
          {...props}
        />,
      ),
    );
    return { ref, onSubmit };
  }

  it("prefills the draft, hides the due date, and totals in the paper's currency", async () => {
    renderBill();
    expect(
      screen.getByRole("heading", { level: 2, name: "Bill from Paper Street Supply" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Due Date")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("INV-7")).toBeInTheDocument();
    const selects = screen.getAllByRole("combobox");
    expect(selects.map((select) => (select as HTMLSelectElement).value)).toEqual([EXPENSE, ASSET]);
    expect(screen.getByText("₱20.00")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Paper Street Supply")).toBeInTheDocument();
  });

  it("reports edits through its handle and hands the whole draft to onSubmit", async () => {
    const user = userEvent.setup();
    const { ref, onSubmit } = renderBill();
    expect(ref.current!.isDirty()).toBe(false);

    const amounts = screen.getAllByPlaceholderText("0.00");
    await user.clear(amounts[0]);
    await user.type(amounts[0], "13.75");
    expect(ref.current!.isDirty()).toBe(true);
    // Untouched fields ride along, including dimensions the form has no field for.
    expect(ref.current!.getDraft().lineItems[0]).toEqual({
      id: "l1",
      description: "Pens",
      amount: "13.75",
      accountId: EXPENSE,
      departmentId: "dept-1",
    });

    act(() => ref.current!.focus());
    expect(screen.getByPlaceholderText("Filter by name or email…")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Save & run checks" }));
    expect(onSubmit).toHaveBeenCalledWith(ref.current!.getDraft());
  });

  it("keeps Save off while the item cannot be edited", () => {
    renderBill({ submitDisabled: true });
    expect(screen.getByRole("button", { name: "Save & run checks" })).toBeDisabled();
  });

  it("gives each line Department and Location pickers and hands the picks to onSubmit", async () => {
    const user = userEvent.setup();
    const { ref, onSubmit } = renderBill({
      dimensionOptions: {
        departments: [
          { value: "dept-1", label: "Operations" },
          { value: "dept-2", label: "Sales" },
        ],
        locations: [{ value: "loc-1", label: "Main Office" }],
      },
    });
    const picker = (name: string) => screen.getByRole("combobox", { name });
    // Line 1 already has a department; line 2 has neither yet.
    expect(picker("Department for line 1")).toHaveTextContent("Operations");
    expect(picker("Location for line 1")).toHaveTextContent("Location");
    expect(picker("Department for line 2")).toHaveTextContent("Department");

    await user.click(picker("Department for line 2"));
    await user.click(await screen.findByRole("option", { name: "Sales" }));
    await user.click(picker("Location for line 2"));
    await user.click(await screen.findByRole("option", { name: "Main Office" }));
    expect(picker("Department for line 2")).toHaveTextContent("Sales");
    expect(picker("Location for line 2")).toHaveTextContent("Main Office");
    // A department can be taken back off a line.
    await user.click(picker("Department for line 1"));
    await user.click(await screen.findByRole("option", { name: "No department" }));
    expect(picker("Department for line 1")).toHaveTextContent("Department");
    expect(ref.current!.isDirty()).toBe(true);

    await user.click(screen.getByRole("button", { name: "Save & run checks" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].lineItems).toEqual([
      { id: "l1", description: "Pens", amount: "12.50", accountId: EXPENSE, departmentId: null },
      {
        id: "l2",
        description: "Prepaid",
        amount: "7.50",
        accountId: ASSET,
        departmentId: "dept-2",
        locationId: "loc-1",
      },
    ]);
  });

  it("shows no dimension pickers unless it is given the options", () => {
    renderBill();
    expect(screen.queryByRole("combobox", { name: /for line/ })).toBeNull();
  });
});

/** The card header's party picker: a combobox trigger showing the chosen party. */
function headerParty() {
  const [trigger] = screen
    .getAllByRole("combobox")
    .filter((element) => element.textContent?.includes("Paper Street Supply"));
  if (!trigger) throw new Error("The header party picker does not show the party.");
  return trigger;
}

describe("TransactionEditor in the reading pane", { timeout: 30_000 }, () => {
  const payOut: TransactionDraft = {
    type: "pay_out",
    date: "2026-09-02",
    referenceNumber: "R-1",
    memo: "Toner",
    journalLines: [
      {
        key: "e",
        description: "",
        categoryId: EXPENSE,
        partyId: "",
        departmentId: "",
        locationId: "",
        debit: "25.00",
        credit: "",
      },
      {
        key: "b",
        description: "",
        categoryId: BANK,
        partyId: "",
        departmentId: "",
        locationId: "",
        debit: "",
        credit: "25.00",
      },
    ],
    payPartyId: VENDOR,
    payCategoryId: BANK,
    payForLines: [
      {
        key: "e",
        description: "",
        categoryId: EXPENSE,
        departmentId: "",
        locationId: "",
        amount: "25.00",
      },
    ],
    transferFromParty: "",
    transferFromCategory: "",
    transferToParty: "",
    transferToCategory: "",
    transferAmount: "",
  };

  function renderTransaction(props: Partial<React.ComponentProps<typeof TransactionEditor>> = {}) {
    const ref = createRef<TransactionEditorHandle>();
    const onSubmit = vi.fn();
    render(
      wrap(
        <TransactionEditor
          ref={ref}
          draft={payOut}
          onSubmit={onSubmit}
          partyOption={{ value: VENDOR, label: "Paper Street Supply" }}
          submitLabel="Save & run checks"
          {...props}
        />,
      ),
    );
    return { ref, onSubmit };
  }

  it("opens on the draft's tab with its one party in the header", async () => {
    renderTransaction();
    const tabs = screen.getByRole("tablist", { name: "Transaction type" });
    expect(within(tabs).getByRole("tab", { name: /Pay Out/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(headerParty()).toHaveTextContent("Paper Street Supply");
    expect(screen.getByDisplayValue("Toner")).toBeInTheDocument();
    expect(screen.getByDisplayValue("R-1")).toBeInTheDocument();
  });

  it("keeps one header party on Journal and drops the per-line pickers it could not store", async () => {
    const user = userEvent.setup();
    renderTransaction();
    await user.click(screen.getByRole("tab", { name: /Journal/ }));
    expect(headerParty()).toHaveTextContent("Paper Street Supply");
    expect(
      screen.queryAllByRole("combobox").filter((element) => element.textContent === "Party"),
    ).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Journal" })).not.toBeInTheDocument();
  });

  it("reports edits through its handle and submits only a valid draft", async () => {
    const user = userEvent.setup();
    const { ref, onSubmit } = renderTransaction();
    await waitFor(() => expect(api.listAccounts).toHaveBeenCalled());
    expect(ref.current!.isDirty()).toBe(false);
    expect(ref.current!.getDraft()).toEqual(payOut);

    const memo = screen.getByPlaceholderText("Add a memo...");
    await user.clear(memo);
    expect(ref.current!.isDirty()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save & run checks" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Please enter a memo describing this pay out."),
    ).toBeInTheDocument();

    await user.type(memo, "Toner cartridges");
    await user.click(screen.getByRole("button", { name: "Save & run checks" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ type: "pay_out", memo: "Toner cartridges" });

    act(() => ref.current!.focus());
    expect(screen.getByDisplayValue("R-1")).toHaveFocus();
  });
});
