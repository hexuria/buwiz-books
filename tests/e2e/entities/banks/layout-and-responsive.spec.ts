import { test, expect } from "@playwright/test";

test.describe("Banks and Cards Layout and Responsive", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/banks");
    await page.waitForLoadState("networkidle");
  });

  test("should display main headers and default structure", async ({ page }) => {
    // Page title — Note: rendered as "Banks & Cards" with HTML entity
    await expect(page.getByText("Banks & Cards").first()).toBeVisible();

    // Count badge
    const countBadge = page.locator("span").filter({ hasText: /^\d+$/ }).first();
    await expect(countBadge).toBeVisible();

    // Primary action button
    const newBtn = page.getByRole("button", { name: "New Account" }).first();
    await expect(newBtn).toBeVisible();
  });

  test("should render list section headers", async ({ page }) => {
    // Sections are conditionally shown if data exists
    const bankSection = page.getByText("Bank Accounts", { exact: false });
    const cardSection = page.getByText("Credit Cards", { exact: false });

    // At least one section should be visible since seed data exists
    const bankVisible = await bankSection.isVisible();
    const cardVisible = await cardSection.isVisible();
    expect(bankVisible || cardVisible).toBeTruthy();
  });
});
