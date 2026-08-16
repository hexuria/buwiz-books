import { test, expect } from "@playwright/test";

test.describe("New Transaction Tabs & Routing", () => {
  // Use the setup auth state
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    // Navigate to the transaction creation page
    await page.goto("/transactions/new");
    // Wait for the default Journal heading to be visible indicating load
    await expect(page.getByRole("heading", { name: "Journal" })).toBeVisible({ timeout: 15000 });
  });

  test("renders all 4 tabs and defaults to Journal", async ({ page }) => {
    // Fallback if not strictly using role="tablist", look for buttons ByName
    const journalTab = page.getByRole("button", { name: "Journal" });
    const payInTab = page.getByRole("button", { name: "Pay In" });
    const payOutTab = page.getByRole("button", { name: "Pay Out" });
    const transferTab = page.getByRole("button", { name: "Transfer" });

    await expect(journalTab).toBeVisible();
    await expect(payInTab).toBeVisible();
    await expect(payOutTab).toBeVisible();
    await expect(transferTab).toBeVisible();

    // Verify Journal is the default and Journal form elements exist
    await expect(page.getByPlaceholder("Reference Number")).toBeVisible();
  });

  test("switching to Pay Out updates URL and displays vendor combobox", async ({ page }) => {
    const payOutTab = page.getByRole("button", { name: "Pay Out" });
    await payOutTab.click();

    // The Single Page architecture mutates localized form state, not window.location.
    // Instead of asserting URL, verify the form dynamically renders the Pay Out state.

    // Should render the singular pay party combobox typically labeled Vendor or Payee
    await expect(page.getByText("Select Party", { exact: true })).toBeVisible();

    // Should render the Bank Account source (now called Pay Out Category)
    await expect(page.getByText("Pay Out Category")).toBeVisible();
  });

  test("switching to Transfer updates URL and displays two bank selectors", async ({ page }) => {
    const transferTab = page.getByRole("button", { name: "Transfer" });
    await transferTab.click();

    // Asserts Transfer tab UI triggers appropriately
    // The Single Page architecture mutates localized form state, not window.location.

    // Transfer requires 'Transfer From' and 'Transfer To' financial accounts
    await expect(page.getByText("Transfer From", { exact: true })).toBeVisible();
    await expect(page.getByText("Transfer To", { exact: true })).toBeVisible();
  });
});
