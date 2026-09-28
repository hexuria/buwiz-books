import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";

/**
 * /inbox renders the new screen only for an organization whose `inbox_v2` flag is on, and the
 * classic page otherwise — including while the flag is unknown to the client (it shows neither
 * rather than flashing the wrong one) and when reading it fails (off is the default). The classic
 * page itself stays in place until the cutover.
 */

const router = vi.hoisted(() => ({
  search: {} as { selected?: string; state?: string },
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: (path: string) => (options: Record<string, unknown>) => ({
    options,
    fullPath: path,
    useSearch: () => router.search,
  }),
  useNavigate: () => router.navigate,
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const flag = vi.hoisted(() => ({ enabled: false, isPending: false }));
vi.mock("../../src/components/inbox-v2/useInboxV2", () => ({
  useInboxV2Enabled: () => ({ enabled: flag.enabled, isPending: flag.isPending }),
}));
vi.mock("../../src/components/inbox-v2/InboxV2Page", () => ({
  InboxV2Page: ({ selectedId }: { selectedId?: string }) => (
    <div data-testid="inbox-v2">selected: {selectedId ?? "none"}</div>
  ),
}));
vi.mock("../../src/components/inbox/DuplicateCasePanel", () => ({
  DuplicateCasePanel: () => null,
}));

const api = vi.hoisted(() => ({
  listInboxItems: vi.fn(),
  getInboxItem: vi.fn(),
  approveInbox: vi.fn(),
  rejectInbox: vi.fn(),
  resolveInboxFinding: vi.fn(),
  retryInboundEmailProcessing: vi.fn(),
  updateInboxCandidate: vi.fn(),
  getInboxSettings: vi.fn(),
  updateInboxSettings: vi.fn(),
  generateInboundEmailAddress: vi.fn(),
}));
vi.mock("../../src/routes/api/-inbox", () => ({
  listInboxItems: api.listInboxItems,
  getInboxItem: api.getInboxItem,
  approveInbox: api.approveInbox,
  rejectInbox: api.rejectInbox,
  resolveInboxFinding: api.resolveInboxFinding,
  retryInboundEmailProcessing: api.retryInboundEmailProcessing,
  updateInboxCandidate: api.updateInboxCandidate,
}));
vi.mock("../../src/routes/api/-inbox-settings", () => ({
  getInboxSettings: api.getInboxSettings,
  updateInboxSettings: api.updateInboxSettings,
  generateInboundEmailAddress: api.generateInboundEmailAddress,
}));
vi.mock("../../src/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-1" } } }) },
}));
vi.mock("../../src/lib/use-permission", () => ({
  usePermission: () => ({ canAccess: true, isLoading: false }),
  useRole: () => ({ role: "owner", isLoading: false }),
}));

async function renderInboxRoute() {
  const { Route } = await import("../../src/routes/inbox");
  const Component = (Route as unknown as { options: { component: React.ComponentType } }).options
    .component;
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <Component />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  router.search = {};
  flag.enabled = false;
  flag.isPending = false;
  api.listInboxItems.mockResolvedValue([]);
  api.getInboxSettings.mockResolvedValue({
    inboundEmailAddress: null,
    requireDifferentApprover: true,
    allowOwnerOverride: true,
  });
});

describe("/inbox screen switch", () => {
  it("renders the classic Inbox when the org flag is off", async () => {
    await renderInboxRoute();
    expect(await screen.findByText("Review queue")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-v2")).not.toBeInTheDocument();
  });

  it("renders Inbox v2, with the URL's selection, when the org flag is on", async () => {
    flag.enabled = true;
    router.search = { selected: "item-42" };
    await renderInboxRoute();
    expect(await screen.findByTestId("inbox-v2")).toHaveTextContent("selected: item-42");
    expect(screen.queryByText("Review queue")).not.toBeInTheDocument();
    expect(api.listInboxItems).not.toHaveBeenCalled();
  });

  it("shows neither screen while the flag is still loading", async () => {
    flag.isPending = true;
    await renderInboxRoute();
    expect(screen.getByLabelText("Loading Inbox")).toBeInTheDocument();
    expect(screen.queryByText("Review queue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inbox-v2")).not.toBeInTheDocument();
  });
});
