import { test, expect } from "@playwright/test";

test.describe("Customers Layout and Responsive", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/customers");
    await page.waitForLoadState("networkidle");
  });

  test("should display main headers and default structure", async ({ page }) => {
    // Check main title
    await expect(page.getByText("Customers", { exact: true }).first()).toBeVisible();

    // Check count badge (span with digits)
    const countBadge = page.locator("span").filter({ hasText: /^\d+$/ }).first();
    await expect(countBadge).toBeVisible();

    // Check the primary button (top right)
    const newBtn = page.getByRole("button", { name: "New Customer" }).first();
    await expect(newBtn).toBeVisible();
  });
});
