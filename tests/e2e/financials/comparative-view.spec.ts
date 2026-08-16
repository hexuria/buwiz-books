import { test, expect } from "@playwright/test";

test.describe("Financials Comparative View", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/financials");
    await page.waitForLoadState("networkidle");
  });

  test("should toggle comparison mode on P&L", async ({ page }) => {
    // Verify vs Prior Period button exists
    const compareBtn = page.getByRole("button", { name: "vs Prior Period" });
    await expect(compareBtn).toBeVisible();

    // Click it
    await compareBtn.click();
    await expect(page).toHaveURL(/compare=prior_period/);

    // Assert Prior column header appears
    const priorCol = page.locator("th", { hasText: "Prior" });
    await expect(priorCol).toBeVisible();

    // Assert Change column header appears
    const changeCol = page.locator("th", { hasText: "Change" });
    await expect(changeCol).toBeVisible();

    // Click vs Prior Period again
    await compareBtn.click();
    await expect(page).not.toHaveURL(/compare=prior_period/);

    // Assert Prior column disappears
    await expect(priorCol).not.toBeVisible();
  });

  test("should show comparison toggle only on supported tabs", async ({ page }) => {
    const compareBtn = page.getByRole("button", { name: "vs Prior Period" });

    // On P&L: assert vs Prior Period is visible
    await expect(compareBtn).toBeVisible();

    // Click Balance Sheet: assert vs Prior Period is visible
    await page.getByRole("button", { name: "Balance Sheet", exact: true }).click();
    await expect(compareBtn).toBeVisible();

    // Click Cash Flow: assert vs Prior Period is NOT visible
    await page.getByRole("button", { name: "Cash Flow", exact: true }).click();
    await expect(compareBtn).not.toBeVisible();

    // Click Trial Balance: assert vs Prior Period is NOT visible
    await page.getByRole("button", { name: "Trial Balance", exact: true }).click();
    await expect(compareBtn).not.toBeVisible();

    // Click Aging: assert vs Prior Period is NOT visible
    await page.getByRole("button", { name: "Aging", exact: true }).click();
    await expect(compareBtn).not.toBeVisible();
  });
});
