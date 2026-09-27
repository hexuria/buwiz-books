import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * /bills/create now renders the shared BillEditor (the Inbox reading pane uses the same form).
 * The route must behave exactly as before the extraction: the first line waits for the mapped
 * default category, Save sends the same createBill payload, and success returns to /bills. The
 * E2E bills lifecycle spec drives the same page; this pins it without a browser.
 */

const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  useNavigate: () => router.navigate,
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const api = vi.hoisted(() => ({
  createBill: vi.fn(),
  listAccounts: vi.fn(),
  getMappedAccounts: vi.fn(),
  listParties: vi.fn(),
  createParty: vi.fn(),
}));
vi.mock("../../src/routes/api/-bills", () => ({ createBill: api.createBill }));
vi.mock("../../src/routes/api/-accounts", () => ({ listAccounts: api.listAccounts }));
vi.mock("../../src/routes/api/-category-mappings", () => ({
  getMappedAccounts: api.getMappedAccounts,
}));
vi.mock("../../src/routes/api/-parties", () => ({
  listParties: api.listParties,
  createParty: api.createParty,
}));

const OFFICE = "11111111-1111-4111-8111-111111111111";
const TRAVEL = "22222222-2222-4222-8222-222222222222";
const VENDOR = "33333333-3333-4333-8333-333333333333";

// The page's own date arithmetic, reproduced: today in UTC, and the due date by adding days to
// local midnight of that date (so it can land a day early east of UTC — unchanged behavior).
function todayISO() {
  return new Date().toISOString().split("T")[0];
}
function addDays(dateStr: string, days: number) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0];
}

async function renderCreatePage() {
  const { Route } = await import("../../src/routes/bills_.create");
  const Page = (Route as unknown as { options: { component: React.ComponentType } }).options
    .component;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Page />
    </QueryClientProvider>,
  );
}

// The per-line category <select>s (the vendor picker is a text input, not a combobox).
function categorySelects() {
  return screen.getAllByRole("combobox");
}

async function chooseVendor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByPlaceholderText("Filter by name or email…"));
  await user.click(await screen.findByText("Acme Office"));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listAccounts.mockResolvedValue([
    { id: OFFICE, accountNumber: "6100", name: "Office Supplies" },
    { id: TRAVEL, accountNumber: "6200", name: "Travel" },
  ]);
  api.getMappedAccounts.mockResolvedValue({ default_expense: TRAVEL });
  api.listParties.mockResolvedValue([
    { id: VENDOR, name: "Acme Office", partyType: "vendor", email: "billing@acme.test" },
  ]);
  api.createBill.mockResolvedValue({ id: "bill-1" });
});

describe("/bills/create through the shared BillEditor", { timeout: 30_000 }, () => {
  it("saves the same createBill payload and returns to /bills", async () => {
    const user = userEvent.setup();
    await renderCreatePage();
    expect(screen.getByRole("heading", { name: "New Bill" })).toBeInTheDocument();

    // The first line appears once the mapped default category is known, and starts on it.
    await waitFor(() => expect(categorySelects()).toHaveLength(1));
    expect(categorySelects()[0]).toHaveValue(TRAVEL);

    await chooseVendor(user);
    await user.type(screen.getByPlaceholderText("e.g. INV-2026-001"), "INV-9");
    await user.type(screen.getByPlaceholderText("Item description..."), "Ergonomic chairs");
    await user.type(screen.getByPlaceholderText("0.00"), "450");
    await user.click(screen.getByRole("button", { name: "Add Item" }));
    await user.type(screen.getAllByPlaceholderText("0.00")[1], "600.5");
    await user.selectOptions(categorySelects()[1], OFFICE);
    expect(screen.getByText("$1,050.50")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save Bill" }));
    await waitFor(() => expect(api.createBill).toHaveBeenCalledTimes(1));
    expect(api.createBill.mock.calls[0][0]).toEqual({
      data: {
        idempotencyKey: expect.any(String),
        vendorId: VENDOR,
        billNumber: "INV-9",
        billDate: todayISO(),
        dueDate: addDays(todayISO(), 30),
        memo: undefined,
        lineItems: [
          { description: "Ergonomic chairs", amount: "450.00", accountId: TRAVEL },
          { description: undefined, amount: "600.50", accountId: OFFICE },
        ],
      },
    });
    await waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: "/bills" }));
  });

  it("says why nothing saved when no default category is mapped", async () => {
    api.getMappedAccounts.mockResolvedValue({ default_expense: null });
    const user = userEvent.setup();
    await renderCreatePage();
    await waitFor(() => expect(categorySelects()).toHaveLength(1));
    // The line starts uncategorized and now says so ("Choose a category"). Before the
    // extraction the select displayed the first account while its value was empty — the one
    // intended change to this page.
    expect(categorySelects()[0]).toHaveValue("");
    expect(screen.getByRole("option", { name: "Choose a category" })).toBeInTheDocument();

    await chooseVendor(user);
    await user.type(screen.getByPlaceholderText("0.00"), "20");
    await user.click(screen.getByRole("button", { name: "Save Bill" }));
    expect(
      screen.getByText(/No default expense category is configured\. Pick a category for each line/),
    ).toBeInTheDocument();
    expect(api.createBill).not.toHaveBeenCalled();
  });

  it("keeps Save off until there is a vendor and an amount", async () => {
    const user = userEvent.setup();
    await renderCreatePage();
    await waitFor(() => expect(categorySelects()).toHaveLength(1));
    const save = screen.getByRole("button", { name: "Save Bill" });
    expect(save).toBeDisabled();
    await chooseVendor(user);
    expect(save).toBeDisabled();
    await user.type(screen.getByPlaceholderText("0.00"), "5");
    expect(save).toBeEnabled();
  });
});
