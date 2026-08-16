import { test, expect } from "@playwright/test";

test.describe("Financials Report Details", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/financials");
    await page.waitForLoadState("networkidle");
  });

  test("should render P&L with expected section labels", async ({ page }) => {
    // Wait for P&L to load
    await expect(page.getByRole("heading", { name: "Profit & Loss", exact: true })).toBeVisible();

    // Assert section labels exist
    await expect(page.getByText("Gross Profit")).toBeVisible();
    await expect(page.getByText("Operating Income")).toBeVisible();
    await expect(page.getByText("Net Income")).toBeVisible();

    // Assert at least one table element is rendered
    await expect(page.locator("table").first()).toBeVisible();
  });

  test("should show trial balance validation message", async ({ page }) => {
    // Click Trial Balance tab
    await page.getByRole("button", { name: "Trial Balance", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Trial Balance", exact: true })).toBeVisible();

    // Assert table headers
    await expect(page.locator("th", { hasText: "Acct #" })).toBeVisible();
    await expect(page.locator("th", { hasText: "Account Name" })).toBeVisible();
    await expect(page.locator("th", { hasText: "Type" })).toBeVisible();
    await expect(page.locator("th", { hasText: "Debit" })).toBeVisible();
    await expect(page.locator("th", { hasText: "Credit" })).toBeVisible();

    // Assert validation message
    await expect(page.getByText("Trial balance is in balance")).toBeVisible();

    // Assert Total row exists in tfoot
    await expect(page.locator("tfoot").getByText("Total", { exact: true })).toBeVisible();
  });

  test("should toggle between AP and AR aging sub-tabs", async ({ page }) => {
    // Click Aging tab
    await page.getByRole("button", { name: "Aging", exact: true }).click();

    // Assert default title is Accounts Payable Aging
    await expect(
      page.getByRole("heading", { name: "Accounts Payable Aging", exact: true }),
    ).toBeVisible();

    // Assert Vendor column header exists
    await expect(page.locator("th", { hasText: "Vendor" })).toBeVisible();

    // Click Accounts Receivable
    await page.getByRole("button", { name: "Accounts Receivable" }).click();
    await expect(page).toHaveURL(/agingType=ar/);

    // Assert title changes to Accounts Receivable Aging
    await expect(
      page.getByRole("heading", { name: "Accounts Receivable Aging", exact: true }),
    ).toBeVisible();

    // Assert Customer column header exists
    await expect(page.locator("th", { hasText: "Customer" })).toBeVisible();

    // Click Accounts Payable
    await page.getByRole("button", { name: "Accounts Payable" }).click();
    await expect(page).toHaveURL(/agingType=ap/);
  });
});
