import { test, expect } from "@playwright/test";

test.describe("Vendors Creation Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/vendors");
    await page.waitForLoadState("networkidle");
  });

  test("should open the creation form and cancel", async ({ page }) => {
    // Click New Vendor
    const newVendorBtn = page.getByRole("button", { name: "New Vendor" }).first();
    await newVendorBtn.click();

    // Check if the panel opens
    const panelHeader = page.getByText("New Vendor", { exact: true }).first();
    await expect(panelHeader).toBeVisible();

    // Locate form fields
    const nameInput = page.getByPlaceholder("Vendor name").first();
    await expect(nameInput).toBeVisible();

    // Try Cancel
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();

    // Panel might close or revert to default header
    await expect(nameInput).not.toBeVisible();
  });

  test("should interact with creation fields without saving", async ({ page }) => {
    const newVendorBtn = page.getByRole("button", { name: "New Vendor" }).first();
    await newVendorBtn.click();

    // Fill standard fields
    await page.getByPlaceholder("Vendor name").first().fill("E2E Test Vendor");
    await page.getByPlaceholder("email@example.com").first().fill("e2e@test.com");
    await page.getByPlaceholder("(555) 123-4567").first().fill("5551234567");
    await page.getByPlaceholder("https://example.com").first().fill("https://e2e.test");

    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
  });

  test("should interact with vendor-specific fields", async ({ page }) => {
    const newVendorBtn = page.getByRole("button", { name: "New Vendor" }).first();
    await newVendorBtn.click();

    // Check 1099 behavior
    const label1099 = page.getByText("1099 Vendor", { exact: true }).first();
    await expect(label1099).toBeVisible();

    // Tax ID is hidden initially
    const taxIdInput = page.getByPlaceholder("XX-XXXXXXX").first();
    await expect(taxIdInput).not.toBeVisible();

    // The checkbox input might have an ID but let's click by label or its input
    // The exact label matches '1099 Vendor'
    await page.getByLabel("1099 Vendor").first().check();
    await expect(taxIdInput).toBeVisible();

    // Payment Information
    const routingInput = page.getByPlaceholder("XXXXXXXXX").first();
    await expect(routingInput).toBeVisible();

    const accountInput = page.getByPlaceholder("XXXXXXXXXXXX").first();
    await expect(accountInput).toBeVisible();

    // Safe cancel
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
  });
});
