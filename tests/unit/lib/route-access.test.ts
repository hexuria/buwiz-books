import { describe, expect, it } from "vitest";
import { getRenderedRoutePathname, isPublicRoutePath } from "@/lib/route-access";

describe("isPublicRoutePath", () => {
  it.each([
    "/login",
    "/login/",
    "/organizations/join",
    "/organizations/join/invitation",
    "/invoices/pay",
    "/invoices/pay/invoice-123",
  ])("allows the public route %s", (pathname) => {
    expect(isPublicRoutePath(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/transactions",
    "/profile",
    "/onboarding",
    "/organization/org-123/settings",
    "/login-history",
    "/organizations/joined",
    "/invoices/payment",
  ])("keeps the protected route %s guarded", (pathname) => {
    expect(isPublicRoutePath(pathname)).toBe(false);
  });
});

describe("getRenderedRoutePathname", () => {
  it("keeps layout decisions on the currently rendered route during navigation", () => {
    expect(
      getRenderedRoutePathname({
        location: { pathname: "/" },
        matches: [{ pathname: "/" }, { pathname: "/login" }],
      }),
    ).toBe("/login");
  });

  it("uses the destination after its matches commit", () => {
    expect(
      getRenderedRoutePathname({
        location: { pathname: "/" },
        matches: [{ pathname: "/" }, { pathname: "/" }],
      }),
    ).toBe("/");
  });

  it("falls back to the location before matches are available", () => {
    expect(
      getRenderedRoutePathname({
        location: { pathname: "/login" },
        matches: [],
      }),
    ).toBe("/login");
  });
});
