import { test, expect } from "@playwright/test";

test.describe("Bills Lifecycle", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  // This lifecycle test performs many sequential steps (create → save → navigate → detail → approve)
  // so it needs more than the default 30s timeout.
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // Go to the bills list
    await page.goto("/bills");
    await page.waitForLoadState("networkidle");
  });

  test("should create a bill manually, view details, and approve", async ({ page }) => {
    // 1. Navigation to Create
    await page.getByRole("link", { name: "Create Bill" }).click();
    await expect(page.getByRole("heading", { name: "New Bill" })).toBeVisible();

    // 2. Fill Metadata
    // Open combobox
    const vendorInput = page.getByPlaceholder("Filter by name or email…");
    await vendorInput.click();

    // Pick the first existing vendor
    const firstVendorBtn = page.locator("button:has(div.font-medium.truncate)").first();
    const vendorName =
      (await firstVendorBtn.locator("div.font-medium.truncate").textContent()) || "Unknown Vendor";
    await firstVendorBtn.click();

    // Verify the combobox closed by checking the input value
    await expect(vendorInput).toHaveValue(vendorName);

    // Fill Bill Number
    const uniqueBillNumber = `INV-E2E-${Date.now()}`;
    await page.getByPlaceholder("e.g. INV-2026-001").fill(uniqueBillNumber);

    // Memo
    await page
      .getByPlaceholder("Add any notes for this bill...")
      .fill("Purchased office chairs and desks");

    // 3. Fill Line Items
    // The first line item is automatically created.
    const descriptionInput = page.getByPlaceholder("Item description...").first();
    await descriptionInput.fill("Ergonomic Chairs");

    const amountInput = page.getByPlaceholder("0.00").first();
    await amountInput.fill("450.00");

    // Add a second line item
    await page.getByRole("button", { name: "Add Item" }).click();
    const secondDescription = page.getByPlaceholder("Item description...").nth(1);
    await secondDescription.fill("Standing Desks");

    const secondAmount = page.getByPlaceholder("0.00").nth(1);
    await secondAmount.fill("600.00");

    // Total should update to 1050.00
    await expect(page.getByText("$1,050.00")).toBeVisible();

    // 4. Save Bill
    await page.getByRole("button", { name: "Save Bill" }).click();

    // Should navigate back to /bills and we should see it in the In Review column
    await expect(page.getByText(uniqueBillNumber).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("$1,050.00").first()).toBeVisible();

    // 5. Open Bill Details
    // Use the unique bill number to ensure we click the exact bill created by this worker
    await page.getByText(uniqueBillNumber).first().click();
    await expect(page.getByText(`Invoice #${uniqueBillNumber}`)).toBeVisible();

    // Verify data in detail view
    await expect(page.getByText(vendorName).first()).toBeVisible();
    await expect(page.getByText("Ergonomic Chairs")).toBeVisible();
    await expect(page.getByText("Standing Desks")).toBeVisible();

    // 6. Assign Approver and Approve
    // The placeholder is "Search members or enter email…" for new bills (no approver yet).
    // It only changes to "Change approver…" after an approver is already assigned.
    const approverInput = page.getByPlaceholder("Search members or enter email…");
    await approverInput.scrollIntoViewIfNeeded();
    await approverInput.click();
    // Press down and enter to select the current user (first in the list)
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Now the button should say "Approve" since we assigned ourselves
    const approveBtn = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approveBtn).toBeVisible({ timeout: 10000 });
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();

    // Verify it transitioned
    // If it's approved, the status might change to Awaiting Payment
    // We can verify that the button changed to "Mark as Paid"
    await expect(page.getByRole("button", { name: "Mark as Paid" })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText("Awaiting Payment")).toBeVisible();
  });
});
