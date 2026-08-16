import { test, expect } from "@playwright/test";

test.describe("Financials Navigation", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/financials");
    await page.waitForLoadState("networkidle");
  });

  test("should display all report tabs and page title", async ({ page }) => {
    // Assert <h1> "Financials" is visible
    await expect(page.getByRole("heading", { name: "Financials" })).toBeVisible();

    // Assert all 5 tab buttons exist
    await expect(page.getByRole("button", { name: "P&L", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Balance Sheet", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cash Flow", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Trial Balance", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Aging", exact: true })).toBeVisible();

    // Assert default report card title is Profit & Loss
    await expect(page.getByRole("heading", { name: "Profit & Loss", exact: true })).toBeVisible();
  });

  test("should switch tabs and update URL", async ({ page }) => {
    // Click Balance Sheet
    await page.getByRole("button", { name: "Balance Sheet", exact: true }).click();
    await expect(page).toHaveURL(/tab=balance-sheet/);
    await expect(page.getByRole("heading", { name: "Balance Sheet", exact: true })).toBeVisible();

    // Click Cash Flow
    await page.getByRole("button", { name: "Cash Flow", exact: true }).click();
    await expect(page).toHaveURL(/tab=cash-flow/);
    await expect(
      page.getByRole("heading", { name: "Cash Flow Statement", exact: true }),
    ).toBeVisible();

    // Click Trial Balance
    await page.getByRole("button", { name: "Trial Balance", exact: true }).click();
    await expect(page).toHaveURL(/tab=trial-balance/);
    await expect(page.getByRole("heading", { name: "Trial Balance", exact: true })).toBeVisible();

    // Click Aging
    await page.getByRole("button", { name: "Aging", exact: true }).click();
    await expect(page).toHaveURL(/tab=aging/);
    await expect(
      page.getByRole("heading", { name: "Accounts Payable Aging", exact: true }),
    ).toBeVisible();
  });

  test("should persist tab state on page reload", async ({ page }) => {
    // Navigate to Cash Flow directly
    await page.goto("/financials?tab=cash-flow");
    await page.waitForLoadState("networkidle");

    // Assert Cash Flow Statement card title is visible
    await expect(
      page.getByRole("heading", { name: "Cash Flow Statement", exact: true }),
    ).toBeVisible();

    // Reload page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Assert card title is still Cash Flow Statement
    await expect(
      page.getByRole("heading", { name: "Cash Flow Statement", exact: true }),
    ).toBeVisible();
  });
});
