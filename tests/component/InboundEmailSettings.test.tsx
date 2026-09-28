import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import { InboundEmailSettings } from "../../src/components/settings/InboundEmailSettings";

/**
 * The inbound email address lives in Settings → Email now that the classic Inbox (and its left
 * rail) is gone. Whoever holds integration:authorize edits, generates, and copies it through the
 * same server functions the rail used; saving sends the approval policy back exactly as loaded.
 * Everyone else sees the address and can copy it, nothing more.
 */

const api = vi.hoisted(() => ({
  getInboxSettings: vi.fn(),
  updateInboxSettings: vi.fn(),
  generateInboundEmailAddress: vi.fn(),
}));
vi.mock("../../src/routes/api/-inbox-settings", () => api);

const permission = vi.hoisted(() => ({ canConfigure: true }));
vi.mock("../../src/lib/use-permission", () => ({
  usePermission: (resource: string, action: string) => ({
    canAccess: resource === "integration" && action === "authorize" && permission.canConfigure,
    isLoading: false,
  }),
}));

const SETTINGS = {
  baseCurrency: "USD",
  timezone: "UTC",
  inboundEmailAddress: "inbox-acme-k3f9q2@inbox.example.com",
  reviewPolicy: "always_review",
  requireDifferentApprover: false,
  allowOwnerOverride: true,
};

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <InboundEmailSettings />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
  permission.canConfigure = true;
  api.getInboxSettings.mockResolvedValue(SETTINGS);
  api.updateInboxSettings.mockImplementation(
    async ({ data }: { data: { inboundEmailAddress: string | null } }) => ({
      inboundEmailAddress: data.inboundEmailAddress,
      requireDifferentApprover: false,
      allowOwnerOverride: true,
    }),
  );
  api.generateInboundEmailAddress.mockResolvedValue({
    inboundEmailAddress: "inbox-acme-zz81ab@inbox.example.com",
  });
});

describe("InboundEmailSettings", () => {
  it("saves an edited address with the approval policy it loaded", async () => {
    const user = userEvent.setup();
    const { invalidate } = renderCard();
    const input = await screen.findByDisplayValue(SETTINGS.inboundEmailAddress);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.clear(input);
    await user.type(input, "bills@inbox.example.com");
    await user.click(save);

    await waitFor(() => expect(api.updateInboxSettings).toHaveBeenCalledTimes(1));
    expect(api.updateInboxSettings.mock.calls[0][0]).toEqual({
      data: {
        inboundEmailAddress: "bills@inbox.example.com",
        requireDifferentApprover: false,
        allowOwnerOverride: true,
      },
    });
    expect(await screen.findByText("Inbound email address saved.")).toBeInTheDocument();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual([
      "inbox",
      "settings",
    ]);
  });

  it("generates a unique address and shows it", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByDisplayValue(SETTINGS.inboundEmailAddress);
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(api.generateInboundEmailAddress).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByDisplayValue("inbox-acme-zz81ab@inbox.example.com"),
    ).toBeInTheDocument();
  });

  it("shows the address read-only to anyone who cannot configure intake", async () => {
    permission.canConfigure = false;
    renderCard();
    expect(await screen.findByText(SETTINGS.inboundEmailAddress)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
  });

  it("says when no address is set up yet", async () => {
    permission.canConfigure = false;
    api.getInboxSettings.mockResolvedValue({ ...SETTINGS, inboundEmailAddress: null });
    renderCard();
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});
