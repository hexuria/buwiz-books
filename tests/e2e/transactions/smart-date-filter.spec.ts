import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/transactions");
  await page.waitForLoadState("networkidle");
});

test.describe("Smart Date Filter Popover & Navigation", () => {
  test("renders the DateRangeNavigator with specific test IDs", async ({ page }) => {
    await expect(page.getByTestId("date-prev")).toBeVisible();
    await expect(page.getByTestId("date-next")).toBeVisible();
    await expect(page.getByTestId("smart-date-filter-trigger")).toBeVisible();
  });

  test("clicking prev/next arrows navigates periods and syncs URL", async ({ page }) => {
    const prevBtn = page.getByTestId("date-prev");
    await prevBtn.click();
    // Playwright captures the updated URL automatically
    await expect(page).toHaveURL(/.*dateFrom=.*/);
    await expect(page.url()).toContain("dateTo=");
  });

  test("opening SmartDateFilter popover shows preset values", async ({ page }) => {
    await page.getByTestId("smart-date-filter-trigger").click();

    // It should render standard accounting presets
    await expect(page.getByText("This Month")).toBeVisible();
    await expect(page.getByText("This Quarter")).toBeVisible();
    await expect(page.getByText("This Year")).toBeVisible();
    await expect(page.getByText("Last Month")).toBeVisible();
  });

  test("clicking a preset applies it and updates URL period", async ({ page }) => {
    // Open the filter
    await page.getByTestId("smart-date-filter-trigger").click();

    // Select this month
    await page.getByText("This Month").click();

    // The filter expects it to be reflected in URL
    await expect(page).toHaveURL(/.*dateFrom=.*/);

    // Ensure popover closes
    await expect(page.getByText("This Month")).toBeHidden();
  });
});
