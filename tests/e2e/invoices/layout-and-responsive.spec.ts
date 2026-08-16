import { test, expect } from "@playwright/test";

test.describe("Invoices Layout and Responsive", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/invoices");
    await page.waitForLoadState("networkidle");
  });

  test("should display kanban view by default with standard columns", async ({ page }) => {
    // Check main title
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();

    // Check count badge (span with digits)
    const countBadge = page
      .locator("span")
      .filter({ hasText: /^\d+ total$/ })
      .first();
    await expect(countBadge).toBeVisible();

    // Check columns
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();
    await expect(page.getByText("Overdue", { exact: true })).toBeVisible();
    await expect(page.getByText("Paid", { exact: true })).toBeVisible();

    // Check primary action
    await expect(page.getByRole("link", { name: "Create Invoice" })).toBeVisible();
  });

  test("should toggle to list view and render correctly", async ({ page }) => {
    // Click list view toggle
    await page.getByTitle("List View").click();

    // Verify URL updates
    await expect(page).toHaveURL(/.*view=list/);

    // Check list view renders table headers
    await expect(page.getByText("Invoice #", { exact: true })).toBeVisible();
    await expect(page.getByText("Customer", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Due Date", { exact: true })).toBeVisible();
  });
});
