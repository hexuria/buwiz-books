import { test, expect } from "@playwright/test";

test.describe("Financials Export Actions", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/financials");
    await page.waitForLoadState("networkidle");
  });

  test("should trigger CSV export download", async ({ page }) => {
    // Wait for P&L data to load
    await expect(page.getByRole("heading", { name: "Profit & Loss", exact: true })).toBeVisible();

    // Set up download listener
    const downloadPromise = page.waitForEvent("download");

    // Click Export CSV
    await page.getByRole("button", { name: /Export CSV/i }).click();

    // Wait for the download
    const download = await downloadPromise;

    // Assert filename matches profit-loss-*.csv
    expect(download.suggestedFilename()).toMatch(/profit-loss.*\.csv/);
  });
});
