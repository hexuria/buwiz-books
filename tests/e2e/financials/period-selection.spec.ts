import { test, expect } from "@playwright/test";

test.describe("Financials Period Selection", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/financials");
    await page.waitForLoadState("networkidle");
  });

  test("should navigate to previous and next period", async ({ page }) => {
    const prevUrl = page.url();

    // Click Previous period
    await page.locator('button[title="Previous period"]').click();

    // Wait for the URL to change
    await page.waitForTimeout(500); // give it a moment to update
    const newUrl = page.url();
    expect(newUrl).not.toEqual(prevUrl);
    expect(newUrl).toContain("dateFrom=");

    // Click Next period
    await page.locator('button[title="Next period"]').click();
    await page.waitForTimeout(500); // give it a moment
    expect(page.url()).toContain("dateFrom=");
  });

  test("should open date filter popover and select a preset", async ({ page }) => {
    // Click date trigger
    await page.locator('[data-testid="smart-date-filter-trigger"]').click();

    // Assert popover search input is visible
    const searchInput = page.getByPlaceholder("Type to filter or search with AI...");
    await expect(searchInput).toBeVisible();

    // Assert preset button This Month is visible
    const presetBtn = page.getByRole("button", { name: "This Month" });
    await expect(presetBtn).toBeVisible();

    // Click This Month
    await presetBtn.click();

    // Assert popover closes
    await expect(searchInput).not.toBeVisible();
  });

  test("should show 'As of' date on point-in-time tabs", async ({ page }) => {
    // Click Trial Balance tab
    await page.getByRole("button", { name: "Trial Balance", exact: true }).click();
    await expect(page).toHaveURL(/tab=trial-balance/);

    // Wait for the tab to fully load
    await expect(page.getByRole("heading", { name: "Trial Balance", exact: true })).toBeVisible();

    // Assert 'As of' is visible in the toolbar
    await expect(page.getByText(/As of/).first()).toBeVisible();

    // Assert the smart date filter trigger is NOT visible (point-in-time tabs show static text)
    await expect(page.locator('[data-testid="smart-date-filter-trigger"]')).not.toBeVisible();
  });
});
