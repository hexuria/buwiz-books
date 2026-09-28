import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";

/**
 * /transactions/new now runs on the shared transaction editor (useTransactionEditor and its
 * parts — the Inbox reading pane uses the same code). The page must behave exactly as before the
 * extraction: the same tabs, the same validation, the same createTransaction payload per tab, and
 * the same navigation to the Inbox item afterwards. The E2E specs under transactions/new drive
 * this page in a browser; this pins the save path without one.
 *
 * The journal form renders each line three times (tablet, desktop and phone layouts, hidden by
 * CSS), so a line's controls are addressed by position: per line three Category pickers and six
 * amount inputs (debit, credit per layout).
 */

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  useNavigate: () => router.navigate,
}));

const api = vi.hoisted(() => ({
  createTransaction: vi.fn(),
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  listParties: vi.fn(),
  createParty: vi.fn(),
  suggestParties: vi.fn(),
  listDepartments: vi.fn(),
  listLocations: vi.fn(),
  listPartyMappings: vi.fn(),
}));
vi.mock("../../src/routes/api/-transactions", () => ({ createTransaction: api.createTransaction }));
vi.mock("../../src/routes/api/-accounts", () => ({
  listAccounts: api.listAccounts,
  createAccount: api.createAccount,
}));
vi.mock("../../src/routes/api/-parties", () => ({
  listParties: api.listParties,
  createParty: api.createParty,
}));
vi.mock("../../src/routes/api/-party-suggestions", () => ({ suggestParties: api.suggestParties }));
vi.mock("../../src/routes/api/-dimensions", () => ({
  listDepartments: api.listDepartments,
  listLocations: api.listLocations,
}));
vi.mock("../../src/routes/api/-party-mappings", () => ({
  listPartyMappings: api.listPartyMappings,
}));
vi.mock("../../src/components/transactions/AttachmentsPanel", () => ({
  default: () => <div>Attachments</div>,
}));
vi.mock("../../src/components/transactions/AIChatPanel", () => ({
  default: () => <div>AI assistant</div>,
}));

const BANK = "11111111-1111-4111-8111-111111111111";
const SUPPLIES = "22222222-2222-4222-8222-222222222222";

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function renderNewTransaction() {
  const { Route } = await import("../../src/routes/transactions_.new");
  const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
    .component;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <Page />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  option: RegExp,
) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}

function categoryPickers(placeholder = "Category") {
  return screen
    .getAllByRole("combobox")
    .filter((element) => element.tagName === "BUTTON" && element.textContent === placeholder);
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no layout: the Combobox scrolls its highlighted option into view.
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
      id: SUPPLIES,
      name: "Office Supplies",
      accountNumber: "6100",
      accountType: "expense",
      subtype: "office_supplies",
      icon: null,
      parentId: null,
      children: [],
    },
  ]);
  api.listParties.mockResolvedValue([]);
  api.suggestParties.mockResolvedValue([]);
  api.listDepartments.mockResolvedValue([]);
  api.listLocations.mockResolvedValue([]);
  api.listPartyMappings.mockResolvedValue({});
  api.createTransaction.mockResolvedValue({ inboxItem: { id: "inbox-item-9" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/transactions/new through the shared transaction editor", { timeout: 30_000 }, () => {
  it("submits a balanced journal to the Inbox and opens the item", async () => {
    const user = userEvent.setup();
    await renderNewTransaction();
    expect(screen.getByRole("heading", { name: "Journal" })).toBeInTheDocument();
    await waitFor(() => expect(api.listAccounts).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText("Add a memo..."), "Office restock");
    await pick(user, categoryPickers()[0], /Office Supplies/);
    // Two-line journals mirror the amount onto the other side.
    await user.type(screen.getAllByPlaceholderText("$0.00")[0], "10.5");
    await pick(user, categoryPickers()[0], /Operating Bank/);

    await user.click(screen.getByRole("button", { name: "Save & Close" }));
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(1));
    expect(api.createTransaction.mock.calls[0][0]).toEqual({
      data: {
        idempotencyKey: expect.any(String),
        transactionDate: localToday(),
        transactionType: "journal",
        memo: "Office restock",
        referenceNumber: undefined,
        documentIds: [],
        lines: [
          {
            accountId: SUPPLIES,
            debit: "10.50",
            credit: undefined,
            lineDescription: undefined,
            partyId: undefined,
            departmentId: undefined,
            locationId: undefined,
            sortOrder: 0,
          },
          {
            accountId: BANK,
            debit: undefined,
            credit: "10.50",
            lineDescription: undefined,
            partyId: undefined,
            departmentId: undefined,
            locationId: undefined,
            sortOrder: 1,
          },
        ],
      },
    });
    await waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith({
        to: "/inbox",
        search: { selected: "inbox-item-9" },
      }),
    );
  });

  it("converts the journal into Pay Out and submits the bank side first", async () => {
    const user = userEvent.setup();
    await renderNewTransaction();
    await waitFor(() => expect(api.listAccounts).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText("Add a memo..."), "Toner");
    await pick(user, categoryPickers()[0], /Office Supplies/);
    await user.type(screen.getAllByPlaceholderText("$0.00")[0], "25");
    await pick(user, categoryPickers()[0], /Operating Bank/);

    await user.click(screen.getByRole("button", { name: /Pay Out/ }));
    // The canonical conversion put the credit (bank) line on the Pay Out account.
    expect(screen.getAllByText("1000 · Operating Bank").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Save & Close" }));
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(1));
    const payload = api.createTransaction.mock.calls[0][0].data;
    expect(payload).toMatchObject({
      transactionType: "pay_out",
      memo: "Toner",
      partyId: undefined,
    });
    expect(payload.lines).toEqual([
      { accountId: BANK, credit: "25.00", sortOrder: 0 },
      { accountId: SUPPLIES, debit: "25.00", lineDescription: "Toner", sortOrder: 1 },
    ]);
  });

  it("validates before saving and says what is missing", async () => {
    const user = userEvent.setup();
    await renderNewTransaction();
    await user.click(screen.getByRole("button", { name: "Save & Close" }));
    expect(
      await screen.findByText("Please enter a memo describing this journal entry."),
    ).toBeInTheDocument();
    expect(api.createTransaction).not.toHaveBeenCalled();
  });

  it("starts over on Save & New instead of leaving the page", async () => {
    const user = userEvent.setup();
    await renderNewTransaction();
    await waitFor(() => expect(api.listAccounts).toHaveBeenCalled());
    const memo = screen.getByPlaceholderText("Add a memo...");
    await user.type(memo, "Stamps");
    await pick(user, categoryPickers()[0], /Office Supplies/);
    await user.type(screen.getAllByPlaceholderText("$0.00")[0], "3");
    await pick(user, categoryPickers()[0], /Operating Bank/);

    const saveMenu = screen.getByRole("button", { name: "Save & Close" }).parentElement!;
    await user.click(within(saveMenu).getAllByRole("button")[1]);
    await user.click(screen.getByRole("button", { name: "Save & New" }));
    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(memo).toHaveValue(""));
    expect(router.navigate).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Transaction submitted to Inbox for review."),
    ).toBeInTheDocument();
  });
});
