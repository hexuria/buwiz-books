import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../src/components/ui/Toast";
import { InboxV2Setting } from "../../src/components/settings/InboxV2Setting";

/**
 * Settings → General carries the per-organization `inbox_v2` switch. Admins flip it through
 * `updateOrgInboxV2Setting`; the Inbox and org-settings caches refresh so /inbox picks the other
 * screen at once. Everyone else sees the state but cannot change it.
 */

const api = vi.hoisted(() => ({ updateOrgInboxV2Setting: vi.fn() }));
vi.mock("../../src/routes/api/-org-settings", () => api);

const session = vi.hoisted(() => ({ role: "admin" as string | null }));
vi.mock("../../src/lib/use-permission", () => ({
  useRole: () => ({ role: session.role, isLoading: false }),
}));

function renderSetting(enabled: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <InboxV2Setting orgId="org-1" enabled={enabled} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.role = "admin";
  api.updateOrgInboxV2Setting.mockImplementation(
    async ({ data }: { data: { enabled: boolean } }) => ({ success: true, enabled: data.enabled }),
  );
});

describe("InboxV2Setting", () => {
  it("is off by default and lets an admin turn it on for the organization", async () => {
    const user = userEvent.setup();
    const { invalidate } = renderSetting(false);
    const toggle = screen.getByRole("switch", { name: "New Inbox" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);
    await waitFor(() => expect(api.updateOrgInboxV2Setting).toHaveBeenCalledTimes(1));
    expect(api.updateOrgInboxV2Setting.mock.calls[0][0]).toEqual({
      data: { organizationId: "org-1", enabled: true },
    });
    expect(
      await screen.findByText("The new Inbox is on for everyone in this organization."),
    ).toBeInTheDocument();
    const refreshed = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(refreshed).toContainEqual(["org-settings"]);
    expect(refreshed).toContainEqual(["inbox"]);
  });

  it("turns it back off", async () => {
    const user = userEvent.setup();
    renderSetting(true);
    await user.click(screen.getByRole("switch", { name: "New Inbox" }));
    await waitFor(() =>
      expect(api.updateOrgInboxV2Setting.mock.calls[0][0]).toEqual({
        data: { organizationId: "org-1", enabled: false },
      }),
    );
  });

  it("shows the state to members without letting them change it", async () => {
    session.role = "member";
    const user = userEvent.setup();
    renderSetting(true);
    const toggle = screen.getByRole("switch", { name: "New Inbox" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Only organization admins can change this.")).toBeInTheDocument();
    await user.click(toggle);
    expect(api.updateOrgInboxV2Setting).not.toHaveBeenCalled();
  });
});
