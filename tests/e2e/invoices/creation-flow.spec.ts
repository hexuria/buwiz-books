import { test, expect } from "@playwright/test";

test.describe("Invoices Creation Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/invoices/draft/create");
    await page.waitForLoadState("networkidle");
  });

  test("should enforce required fields when saving", async ({ page }) => {
    // Wait for auto-generated invoice number to settle
    await page.waitForTimeout(1000);

    await expect(page.getByRole("button", { name: "Save Invoice" })).toBeDisabled();

    // The component disables the button until a customer is selected
  });

  test("should add and calculate multiple line items", async ({ page }) => {
    // Select customer
    const customerInput = page.getByPlaceholder("Filter by name or email…");
    await customerInput.click();
    const firstCustomerBtn = page.locator("button:has(div.font-medium.truncate)").first();
    await firstCustomerBtn.click();

    // Add first line item
    const row1 = page.locator("tr.group\\/row").nth(0);
    await row1.locator('input[type="text"]').first().fill("Consulting Services");
    await row1.locator('input[type="number"]').first().fill("5"); // qty
    await row1.locator('input[type="number"]').nth(1).fill("200.00"); // price

    // Click 'Add Item'
    await page.getByRole("button", { name: "Add Item" }).click();

    // Add second line item
    const row2 = page.locator("tr.group\\/row").nth(1);
    await row2.locator('input[type="text"]').first().fill("Software License");
    await row2.locator('input[type="number"]').first().fill("1"); // qty
    await row2.locator('input[type="number"]').nth(1).fill("500.00"); // price

    // Verify subtotal/total calculation
    // 5 * 200 = 1000, 1 * 500 = 500. Total = 1500
    await expect(page.getByText("$1,500.00").first()).toBeVisible();

    // Remove first row
    await row1
      .getByRole("button")
      .filter({ has: page.locator('svg[stroke="currentColor"]') })
      .last()
      .click();

    // Verify new total is just the license (500)
    await expect(page.getByText("$500.00").first()).toBeVisible();
  });
});
