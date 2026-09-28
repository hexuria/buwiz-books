import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AppSidebar from "../../src/components/AppSidebar";

/**
 * The Review Agents page is retired: its configuration lives in Settings -> Review Rules and
 * `/review-agents` redirects to the Inbox. A nav entry would now be a link that bounces, so the
 * sidebar must not offer one on either navigation surface — the desktop rail or the compact
 * drawer and tab bar.
 *
 * Everything the sidebar reads from the session, the organization and the router is stubbed; the
 * nav config itself is the real one.
 */

const layout = vi.hoisted(() => ({ compact: false }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/inbox" } }),
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../../src/components/ThemeContext", () => ({
  useTheme: () => ({ mode: "light", setMode: vi.fn() }),
}));
vi.mock("../../src/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "user-1", name: "Test Owner", email: "owner@test.local" } },
  }),
  signOut: vi.fn(),
}));
vi.mock("../../src/components/OrganizationSwitcher", () => ({
  OrganizationSwitcher: () => null,
}));
vi.mock("../../src/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ data: { id: "org-1", name: "Acme Books", slug: "acme" } }),
}));
vi.mock("../../src/hooks/useBreakpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/hooks/useBreakpoint")>()),
  useIsCompactNav: () => layout.compact,
}));
vi.mock("../../src/hooks/useOverlayBehavior", () => ({ useScrollLock: () => {} }));
vi.mock("../../src/hooks/usePhTaxFilingEnabled", () => ({
  usePhTaxFilingEnabled: () => ({ enabled: false, isPending: false }),
}));
vi.mock("../../src/routes/api/-tax-module-state", () => ({ getTaxModuleState: vi.fn() }));

function renderSidebar() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AppSidebar collapsed={false} onToggleCollapse={() => {}}>
        <p>page</p>
      </AppSidebar>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  layout.compact = false;
});

describe("AppSidebar without Review Agents", () => {
  it("keeps Inbox in the desktop rail but drops Review Agents", () => {
    const { container } = renderSidebar();

    expect(container.querySelector('a[href="/inbox"]')).not.toBeNull();
    expect(screen.queryByText("Review Agents")).toBeNull();
    expect(container.querySelector('a[href^="/review-agents"]')).toBeNull();
  });

  it("offers no Review Agents link in the compact drawer or tab bar either", () => {
    layout.compact = true;
    const { container } = renderSidebar();

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.queryByText("Review Agents")).toBeNull();
    expect(container.querySelector('a[href^="/review-agents"]')).toBeNull();
  });

  it("still links to Settings, where review rules now live", () => {
    const { container } = renderSidebar();
    expect(container.querySelector('a[href="/organization/org-1/settings"]')).not.toBeNull();
  });
});
