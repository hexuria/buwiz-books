import { test, expect } from "@playwright/test";

test.describe("Banks and Cards Creation Flow", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/banks");
    await page.waitForLoadState("networkidle");
  });

  test("should open the creation form and cancel", async ({ page }) => {
    const newBtn = page.getByRole("button", { name: "New Account" }).first();
    await newBtn.click();
    await page.waitForTimeout(500);

    // Panel header — "New Account"
    const panelHeader = page.getByText("New Account", { exact: true }).first();
    await expect(panelHeader).toBeVisible();

    // Account name field
    const nameInput = page.getByPlaceholder("e.g. Mercury Checking").first();
    await expect(nameInput).toBeVisible();

    // Safe cancel — button label is "Cancel"
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();

    await expect(nameInput).not.toBeVisible();
  });

  test("should interact with creation fields without saving", async ({ page }) => {
    const newBtn = page.getByRole("button", { name: "New Account" }).first();
    await newBtn.click();
    await page.waitForTimeout(500);

    // Fill Account Name
    await page.getByPlaceholder("e.g. Mercury Checking").first().fill("E2E Test Bank");

    // Fill Institution Name
    await page.getByPlaceholder("e.g. Mercury, Chase, Wells Fargo").first().fill("Test Bank");

    // Fill Last Four Digits
    await page.getByPlaceholder("1234").first().fill("9999");

    // Select account type — click the "Savings" type button
    const savingsBtn = page.getByRole("button", { name: "Savings" });
    await savingsBtn.click();

    // Safe cancel
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
  });

  test("should show Create Account submit button (non-destructive check)", async ({ page }) => {
    const newBtn = page.getByRole("button", { name: "New Account" }).first();
    await newBtn.click();
    await page.waitForTimeout(500);

    // Confirm the submit button text for new mode is "Create Account"
    const submitBtn = page.getByRole("button", { name: "Create Account" });
    await expect(submitBtn).toBeVisible();

    // Cancel safely
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
  });
});
