import { test, expect } from "@playwright/test";

test.describe("Invoices Lifecycle", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  // Multi-step lifecycle: create → save → kanban → detail → review → send → paid
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // Go to the invoices list
    await page.goto("/invoices");
    await page.waitForLoadState("networkidle");
  });

  test("should create an invoice manually, review, mark as sent, and mark as paid", async ({
    page,
  }) => {
    // 1. Navigation to Create
    await page.getByRole("link", { name: "Create Invoice" }).click();
    await expect(page.getByRole("heading", { name: "New Invoice" })).toBeVisible();

    // Give the nextInvoiceNumber useQuery time to resolve from the server
    // so we don't accidentally capture and submit the "INV-0001" fallback loading state.
    await page.waitForTimeout(2000);

    // 2. Fill Metadata
    // Open combobox
    const customerInput = page.getByPlaceholder("Filter by name or email…");
    await customerInput.click();

    // Pick the first existing customer
    const firstCustomerBtn = page.locator("button:has(div.font-medium.truncate)").first();
    const customerName =
      (await firstCustomerBtn.locator("div.font-medium.truncate").textContent()) ||
      "Unknown Customer";
    await firstCustomerBtn.click();

    // Verify the combobox closed by checking the input value
    await expect(customerInput).toHaveValue(customerName);

    // Notes
    await page
      .getByPlaceholder("Add any notes for the customer...")
      .fill("Services rendered for Q1");

    // 3. Fill Line Items
    const row = page.locator("tbody tr").first();
    await row.locator('input[type="text"]').first().fill("Web Development");

    // The amount/quantity/price inputs
    const qtyInput = row.locator('input[type="number"]').first();
    await qtyInput.fill("10");

    const priceInput = row.locator('input[type="number"]').nth(1);
    await priceInput.fill("150.00");

    const revenueAccountSelect = row.getByLabel("Revenue account for line 1");
    const salesRevenueId = await revenueAccountSelect
      .locator("option")
      .filter({ hasText: "Sales Revenue" })
      .getAttribute("value");
    expect(salesRevenueId).toBeTruthy();
    await revenueAccountSelect.selectOption(salesRevenueId!);

    // Total should update to 1,500.00
    await expect(page.getByText("$1,500.00").first()).toBeVisible();

    // Capture the auto-generated invoice number right before saving.
    // By doing this after filling out the form, we ensure the nextInvoiceNumber query
    // has finished resolving the true sequence number (e.g. INV-0002) rather than the "INV-0001" fallback.
    const invoiceNumberInput = page.locator('input[readonly][value^="INV-"]');
    const invoiceNumber = await invoiceNumberInput.inputValue();

    // 4. Save Invoice — wait for navigation back to /invoices
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/invoices"),
      page.getByRole("button", { name: "Save Invoice" }).click(),
    ]);

    // Should see the invoice in the kanban
    await expect(page.getByText(customerName).first()).toBeVisible({ timeout: 10000 });

    // 5. Open Invoice Details — find the card by its unique invoice number
    // The kanban card shows the invoiceNumber (e.g. "INV-0001") as a subtitle.
    // This is unique per browser worker, avoiding stale-card collisions.
    const draftColumn = page
      .locator(".flex-col")
      .filter({ has: page.getByText("Draft", { exact: true }) });
    const draftCard = draftColumn.locator("button").filter({ hasText: invoiceNumber }).first();
    await expect(draftCard).toBeVisible({ timeout: 10000 });
    await draftCard.click();

    // Wait for the draft detail page to load (it has the "Review" button)
    await expect(page.getByRole("button", { name: "Review" })).toBeVisible({ timeout: 15000 });

    // Verify data in detail view
    await expect(page.getByPlaceholder("Search products...").first()).toHaveValue(
      "Web Development",
    );

    // 6. Review Invoice
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByText("Invoice Customization")).toBeVisible({ timeout: 10000 });

    // 7. Mark as Sent
    await page
      .locator("button")
      .filter({ has: page.locator('path[d="M7 10l5 5 5-5z"]') })
      .click();

    const markAsSentBtn = page.getByRole("button", { name: "Mark as Sent" });
    await expect(markAsSentBtn).toBeVisible();
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/invoices"),
      markAsSentBtn.click(),
    ]);

    // 8. We should be back on /invoices
    // Wait for the invoice to appear in the Sent column (2nd column in Kanban)
    const sentCol = page.locator(".flex.gap-4 > .flex-col").nth(1);
    const sentInvoiceCard = sentCol.locator("button").filter({ hasText: invoiceNumber }).first();
    await expect(sentInvoiceCard).toBeVisible({ timeout: 15000 });

    // 9. Mark as Paid
    await sentInvoiceCard.click();
    await expect(page.getByRole("button", { name: "Actions" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("button", { name: "Record Payment" }).click();

    // Fill Record Payment Modal
    await expect(page.getByRole("heading", { name: "Record Payment" })).toBeVisible();
    await page.locator("select").selectOption({ index: 1 }); // Select deposit account
    await page.getByRole("button", { name: "Confirm Payment" }).click(); // Confirm modal

    // Verify it navigates back and is marked as paid
    await expect(page.getByText("Paid").first()).toBeVisible({ timeout: 10000 });
  });
});
