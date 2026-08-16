import { test, expect } from "@playwright/test";

test.describe("Accounts Page Layout", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/accounts");
    // The table might take a moment to fetch and render
    await page.waitForLoadState("networkidle");
  });

  test("should display Category Manager header and back button", async ({ page }) => {
    // Header
    await expect(page.getByText("Category Manager").first()).toBeVisible();

    // Back to Dashboard link
    const backBtn = page.getByRole("link", { name: /Back to Dashboard/i });
    await expect(backBtn).toBeVisible();
    await expect(backBtn).toHaveAttribute("href", "/");
  });

  test("should display main search and filter controls", async ({ page }) => {
    // Search input placeholder
    const searchInput = page.getByPlaceholder("Lookup category...");
    await expect(searchInput).toBeVisible();

    // "New Category" main button
    const newCategoryBtn = page.getByRole("button", { name: "New Category" }).first();
    await expect(newCategoryBtn).toBeVisible();

    // Filter trigger button
    const filterBtn = page.getByTitle("Filters");
    await expect(filterBtn).toBeVisible();
  });
});
