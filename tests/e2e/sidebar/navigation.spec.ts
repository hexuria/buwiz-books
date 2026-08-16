import { test, expect } from "@playwright/test";

test.describe("Sidebar Navigation Integrity", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    // Mount starting at /profile to establish the sidebar wrapper
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
  });

  test("can appropriately collapse and expand major grouping containers natively", async ({
    page,
  }) => {
    // Both Accounting and Entities are open by default per codebase initial state
    const ledgerLink = page.getByRole("link", { name: "Ledger", exact: true });
    const banksLink = page.getByRole("link", { name: "Banks & Cards", exact: true });

    // Assert visual stability
    await expect(ledgerLink).toBeVisible();
    await expect(banksLink).toBeVisible();

    // Trigger Accounting collapse
    const accountingBtn = page.getByRole("button", { name: "Accounting", exact: true });
    await accountingBtn.click();

    // Assert children are removed dynamically
    await expect(ledgerLink).toBeHidden();

    // Mitigate Firefox Headless crash by waiting for the 200ms `max-h` CSS transition to settle explicitly
    // before allowing Playwright bounding-box calculation logic to hammer `entitiesBtn`.
    await page.waitForTimeout(300);

    // Trigger Entities collapse
    const entitiesBtn = page.getByRole("button", { name: "Entities", exact: true });
    await entitiesBtn.click();

    // Assert children are removed dynamically
    await expect(banksLink).toBeHidden();

    // Mitigate Firefox Headless crash
    await page.waitForTimeout(300);

    // Expand both back
    await accountingBtn.click();
    await expect(ledgerLink).toBeVisible();

    await entitiesBtn.click();
    await expect(banksLink).toBeVisible();
  });

  test("contains stable mapping resolving across all defined navigation routes", async ({
    page,
  }) => {
    /**
     * E2E Parity Map representing exactly every static nested/flat route
     * defined inside `AppSidebar.tsx` to verify zero router breakages.
     */
    const routes = [
      { name: "Ledger", path: "/transactions" },
      { name: "Reconciliations", path: "/reconciliations" },
      { name: "Category Manager", path: "/accounts" },
      { name: "Departments", path: "/departments" },
      { name: "Locations", path: "/locations" },
      { name: "Financials", path: "/financials" },
      { name: "Bills", path: "/bills" },
      { name: "Invoices", path: "/invoices" },
      { name: "Documents", path: "/documents" },
      { name: "Banks & Cards", path: "/entities/banks" },
      { name: "Vendors", path: "/entities/vendors" },
      { name: "Customers", path: "/entities/customers" },
      { name: "Employees", path: "/entities/employees" },
      { name: "Shareholders", path: "/entities/shareholders" },
      { name: "Lenders", path: "/entities/lenders" },
      { name: "Government", path: "/entities/government" },
    ];

    for (const route of routes) {
      // 1. Locate explicitly to avoid mismatching nested content
      const navLink = page.getByRole("link", { name: route.name, exact: true });
      await expect(navLink).toBeVisible();

      // 2. Perform native click navigation
      await navLink.click();

      // 3. Assert TanStack Router processed internal soft-navigation correctly
      await page.waitForURL(`**${route.path}*`);
      expect(page.url()).toContain(route.path);
    }
  });
});
