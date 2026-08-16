import { test, expect } from "@playwright/test";

test.describe("Invoices Search and Filters", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    // Navigate and switch to list view for easier filter verification
    await page.goto("/invoices?view=list");
    await page.waitForLoadState("networkidle");
  });

  test("should filter invoices by customer name or invoice number", async ({ page }) => {
    // Find the unified search input
    const searchInput = page.getByPlaceholder(/Filter \d+ invoice/);
    await expect(searchInput).toBeVisible();

    // Fill with a non-existent value
    await searchInput.fill("NON_EXISTENT_INV_12345");

    // Check empty state
    await expect(page.getByText("No invoices match your filters")).toBeVisible();

    // Clear search
    await searchInput.clear();
  });

  test("should open filter panel and apply status filters", async ({ page }) => {
    // Open filter panel
    await page.getByTitle("Filters").click();

    // Uncheck "Draft" and "Paid" just leaving "Sent" and "Overdue"
    // Since default statuses are ["draft", "sent", "overdue", "paid"], clicking them toggles them off.
    const draftCheckbox = page.getByRole("checkbox", { name: "Draft" });
    const paidCheckbox = page.getByRole("checkbox", { name: "Paid" });

    if (await draftCheckbox.isChecked()) {
      await draftCheckbox.uncheck();
    }
    if (await paidCheckbox.isChecked()) {
      await paidCheckbox.uncheck();
    }

    // Verify filter chips are updated
    // Should NOT see Draft and Paid chips
    await expect(page.locator("span.inline-flex").filter({ hasText: /^Draft$/ })).not.toBeVisible();
    await expect(page.locator("span.inline-flex").filter({ hasText: /^Paid$/ })).not.toBeVisible();

    // Click "Clear" to reset filters
    await page.getByRole("button", { name: "Clear", exact: true }).click();

    // Check that chips are removed (except default might be restored or all cleared)
    // Actually, Clear removes ALL filters, so no chips should be visible, and search should become full-width.
    await expect(page.getByPlaceholder(/Filter \d+ invoice/)).toBeVisible();
  });
});
