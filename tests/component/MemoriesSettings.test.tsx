import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import {
  MemoriesSettings,
  type MemoryListItem,
} from "../../src/components/settings/MemoriesSettings";

/**
 * Settings → Memories (Inbox v2 §7): what is remembered, how often it answered and was undone,
 * which memories turned themselves off, and — for owners and admins — turning memories on, off,
 * or deleting them through the server functions (mocked here).
 */

const api = vi.hoisted(() => ({
  rememberCorrection: vi.fn(),
  previewMemoryScope: vi.fn(),
  listMemories: vi.fn(),
  enableMemory: vi.fn(),
  disableMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));
vi.mock("../../src/routes/api/-inbox-memory", () => api);

const permission = vi.hoisted(() => ({ configure: true, loading: false }));
vi.mock("../../src/lib/use-permission", () => ({
  usePermission: (resource: string, action: string) => ({
    canAccess: permission.loading
      ? false
      : resource === "agentRule" && action === "configure"
        ? permission.configure
        : true,
    isLoading: permission.loading,
  }),
}));

function memory(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    matchKind: "sender_party",
    keyLabel: "receipts@staples.test · tax id 123456789000",
    enabled: true,
    autoDisabled: false,
    uses: 3,
    undos: 1,
    consecutiveUndos: 0,
    answer: {
      docKind: "purchase",
      party: { id: "00000000-0000-4000-8000-0000000000p1", name: "Staples" },
      lines: [
        { side: "debit", accountId: "a1", accountLabel: "67200 · Office Supplies" },
        { side: "credit", accountId: "a2", accountLabel: "11000 · Bank Accounts" },
      ],
    },
    problem: null,
    createdBy: { id: "u1", name: "Maria Santos" },
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

const ACTIVE = memory();
const WORN_OUT = memory({
  id: "00000000-0000-4000-8000-000000000002",
  matchKind: "line_text",
  keyLabel: "coffee green sack",
  enabled: false,
  autoDisabled: true,
  uses: 5,
  undos: 2,
  consecutiveUndos: 2,
  answer: {
    docKind: "bill_accrual",
    party: null,
    lines: [
      { side: "debit", accountId: "a3", accountLabel: "50000 · Cost of Goods" },
      { side: "credit", accountId: "a4", accountLabel: "21000 · Accounts Payable" },
    ],
  },
  problem: "An account in the answer is inactive.",
});

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoriesSettings />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function rowFor(label: string) {
  return screen.findByRole("listitem", { name: new RegExp(label, "u") });
}

beforeEach(() => {
  vi.clearAllMocks();
  permission.configure = true;
  permission.loading = false;
  api.listMemories.mockResolvedValue([ACTIVE, WORN_OUT]);
});

describe("MemoriesSettings", () => {
  it("lists what is remembered, what it answers, and how it has fared", async () => {
    renderSection();
    const active = await rowFor("This sender: receipts@staples.test");
    expect(within(active).getByText("Paid expense · Staples")).toBeInTheDocument();
    expect(within(active).getByText("Debit 67200 · Office Supplies")).toBeInTheDocument();
    expect(within(active).getByText("Credit 11000 · Bank Accounts")).toBeInTheDocument();
    expect(
      within(active).getByText(/Answered 3 times · undone once · saved by Maria Santos/u),
    ).toBeInTheDocument();
    expect(within(active).getByText("On")).toBeInTheDocument();

    const wornOut = await rowFor("These words: coffee green sack");
    expect(within(wornOut).getByText("Vendor bill")).toBeInTheDocument();
    expect(within(wornOut).getByText("Turned off after two undos in a row")).toBeInTheDocument();
    expect(
      within(wornOut).getByText("Skipped on new papers: An account in the answer is inactive."),
    ).toBeInTheDocument();
  });

  it("lets an admin turn a memory off and back on", async () => {
    const user = userEvent.setup();
    api.disableMemory.mockResolvedValue({ id: ACTIVE.id, enabled: false });
    api.enableMemory.mockResolvedValue({ id: WORN_OUT.id, enabled: true });
    renderSection();
    const active = await rowFor("This sender");
    await user.click(within(active).getByRole("button", { name: /Turn off memory/u }));
    await waitFor(() =>
      expect(api.disableMemory).toHaveBeenCalledWith({ data: { memoryId: ACTIVE.id } }),
    );
    expect(await screen.findByText("Memory turned off.")).toBeInTheDocument();
    // The list is re-read after a change.
    await waitFor(() => expect(api.listMemories).toHaveBeenCalledTimes(2));

    const wornOut = await rowFor("These words");
    await user.click(within(wornOut).getByRole("button", { name: /Turn on memory/u }));
    await waitFor(() =>
      expect(api.enableMemory).toHaveBeenCalledWith({ data: { memoryId: WORN_OUT.id } }),
    );
  });

  it("asks before deleting", async () => {
    const user = userEvent.setup();
    api.deleteMemory.mockResolvedValue({ id: ACTIVE.id, deleted: true });
    renderSection();
    const active = await rowFor("This sender");
    await user.click(within(active).getByRole("button", { name: /Delete memory/u }));
    expect(within(active).getByText("Delete this memory?")).toBeInTheDocument();
    await user.click(within(active).getByRole("button", { name: "Cancel" }));
    expect(api.deleteMemory).not.toHaveBeenCalled();

    await user.click(within(active).getByRole("button", { name: /Delete memory/u }));
    await user.click(within(active).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api.deleteMemory).toHaveBeenCalledWith({ data: { memoryId: ACTIVE.id } }),
    );
    expect(await screen.findByText("Memory deleted.")).toBeInTheDocument();
  });

  it("shows the server's refusal", async () => {
    const user = userEvent.setup();
    api.disableMemory.mockRejectedValue(new Error("Permission denied: configure on agentRule"));
    renderSection();
    const active = await rowFor("This sender");
    await user.click(within(active).getByRole("button", { name: /Turn off memory/u }));
    expect(
      await screen.findByText("Permission denied: configure on agentRule"),
    ).toBeInTheDocument();
  });

  it("is read-only without the configure permission", async () => {
    permission.configure = false;
    renderSection();
    const active = await rowFor("This sender");
    expect(within(active).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      /can see what is remembered but not change it/u,
    );
  });

  it("says when nothing is remembered yet", async () => {
    api.listMemories.mockResolvedValue([]);
    renderSection();
    expect(await screen.findByText(/Nothing is remembered yet/u)).toBeInTheDocument();
  });

  it("reports a failed load and retries", async () => {
    const user = userEvent.setup();
    api.listMemories.mockRejectedValueOnce(new Error("Network down"));
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await rowFor("This sender")).toBeInTheDocument();
  });
});
