import { describe, expect, it } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { Route } from "../../src/routes/review-agents";

/**
 * `/review-agents` is retired but kept as a route so old bookmarks and links do not 404. It never
 * renders: its beforeLoad sends the visitor on. (Authentication still runs first: the root route's
 * beforeLoad sends a signed-out visitor to /login, and hands this route its `routeAuth`.)
 *
 * The Inbox used to mint `/review-agents?agent=<rule>` on every finding. Those links now open that
 * rule in Settings when the session names an active organization, and fall back to the Inbox when
 * it does not.
 */
describe("/review-agents", () => {
  type RedirectOptions = {
    to?: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    replace?: boolean;
  };

  function redirectFor(input: {
    agent?: unknown;
    activeOrganizationId?: string | null;
  }): RedirectOptions {
    const validateSearch = Route.options.validateSearch as (
      search: Record<string, unknown>,
    ) => Record<string, unknown>;
    const search = validateSearch({ agent: input.agent });
    const beforeLoad = Route.options.beforeLoad as unknown as (ctx: unknown) => unknown;
    let thrown: unknown;
    try {
      beforeLoad({
        search,
        context: {
          routeAuth: {
            userId: "user-1",
            activeOrganizationId: input.activeOrganizationId ?? null,
          },
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);
    return (thrown as { options: RedirectOptions }).options;
  }

  it("sends an old rule link to that rule in the active organization's Settings", () => {
    const options = redirectFor({ agent: "missing_receipt", activeOrganizationId: "org-1" });
    expect(options.to).toBe("/organization/$orgId/settings");
    expect(options.params).toEqual({ orgId: "org-1" });
    expect(options.search).toEqual({ section: "review-rules", rule: "missing_receipt" });
    expect(options.replace).toBe(true);
  });

  it("falls back to the Inbox when the session has no active organization", () => {
    const options = redirectFor({ agent: "missing_receipt", activeOrganizationId: null });
    expect(options.to).toBe("/inbox");
    expect(options.replace).toBe(true);
  });

  it("sends the bare page, or a malformed rule, to the Inbox", () => {
    expect(redirectFor({ activeOrganizationId: "org-1" }).to).toBe("/inbox");
    expect(redirectFor({ agent: "", activeOrganizationId: "org-1" }).to).toBe("/inbox");
    expect(redirectFor({ agent: "x".repeat(65), activeOrganizationId: "org-1" }).to).toBe("/inbox");
    expect(redirectFor({ agent: 42, activeOrganizationId: "org-1" }).to).toBe("/inbox");
  });

  it("renders nothing of its own", () => {
    expect(Route.options.component).toBeUndefined();
  });
});
