import { test, expect } from "@playwright/test";

test.describe("Chart of Accounts - System Protections", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    // Go to accounts with tree view visible
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
  });

  test("should protect system accounts from deletion", async ({ page }) => {
    // 1. Locate a known system account (e.g. Equity)
    // First, expand Equity if needed, but the tree might just display it.
    // Let's search for it to be safe
    const searchInput = page.getByPlaceholder(/Lookup category/i);
    await searchInput.fill("Equity");

    // Click the row
    const row = page.locator(".group.grid").filter({ hasText: "Equity" }).first();
    await expect(row).toBeVisible();
    await row.click();

    // 2. Verify detail panel is open
    const desktopPanel = page.locator("div.hidden.lg\\:block");
    await expect(desktopPanel.getByText("Equity", { exact: true }).first()).toBeVisible();

    // 3. Verify Delete button is NOT present because it is a system account
    const deleteBtn = desktopPanel.locator('button[title="Delete"]');
    await expect(deleteBtn).not.toBeVisible();

    // 4. Verify Edit button is present
    const editBtn = desktopPanel.locator('button[title="Edit"]');
    await expect(editBtn).toBeVisible();
  });

  test("should protect root accounts from deactivation", async ({ page }) => {
    // 1. Locate a known root account (e.g. Asset, Liability, Equity, Revenue, Expense)
    // Clear search just in case
    const searchInput = page.getByPlaceholder(/Lookup category/i);
    await searchInput.fill("Asset");

    // Click the row that has exactly "Asset" and "No parent" or similar.
    // The name in the tree is just "Asset"
    const row = page.locator(".group.grid").filter({ hasText: "Asset" }).first();
    await expect(row).toBeVisible();
    await row.click();

    // 2. Open edit form
    const desktopPanel = page.locator("div.hidden.lg\\:block");
    await desktopPanel.locator('button[title="Edit"]').click();
    await expect(page).toHaveURL(/.*mode=edit.*/);

    // 3. Verify Deactivate button is disabled and has correct title
    const deactivateBtn = desktopPanel.getByRole("button", {
      name: /Deactivate Category|Activate Category/i,
    });
    await expect(deactivateBtn).toBeVisible();
    await expect(deactivateBtn).toBeDisabled();
    await expect(deactivateBtn).toHaveAttribute("title", "Root categories cannot be deactivated");
  });
});
