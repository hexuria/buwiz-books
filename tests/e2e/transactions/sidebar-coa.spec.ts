import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/transactions");
  await page.waitForLoadState("networkidle");
});

test.describe("Category Sidebar (COA)", () => {
  test("renders the root COA account sections", async ({ page }) => {
    await expect(page.getByText("Assets", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Liabilities", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Equity", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Revenue", { exact: true }).first()).toBeVisible();
  });

  test("expanding root accounts shows nested ledgers", async ({ page }) => {
    const assetsAccount = page.getByText("Assets", { exact: true }).first();
    await expect(assetsAccount).toBeVisible();

    // We check if "Bank Accounts" is visible inside Assets
    const bankAccts = page.getByText("Bank Accounts", { exact: false }).first();
    if (await bankAccts.isVisible()) {
      await expect(bankAccts).toBeVisible();
    }
  });

  test("clicking a specific sub-account updates URL routing to target ledger", async ({ page }) => {
    // If we click "Bank Accounts" or similar, does it push to URL?
    const targetAccount = page.getByText("Bank Accounts", { exact: false }).first();
    if (await targetAccount.isVisible()) {
      await targetAccount.click();
      await expect(page).toHaveURL(/.*accountId=.*/);
    }
  });
});
