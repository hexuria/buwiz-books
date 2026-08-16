import { test, expect } from "@playwright/test";

test.describe("Settings Email Tab", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await settingsLink.click();
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await page.getByRole("button", { name: "Email", exact: true }).click();
  });

  test("should load sender identity fields", async ({ page }) => {
    const senderNameLabel = page.locator("label:has-text('Sender Name')");
    await expect(senderNameLabel).toBeVisible();

    const senderEmailLabel = page.locator("label:has-text('Sender Email')");
    await expect(senderEmailLabel).toBeVisible();
  });

  test("should update sender name safely", async ({ page }) => {
    // The Email section has: label "Sender Name" → input[type=text], label "Sender Email" → input[type=email]
    const safeNameInput = page.locator("input[type='text']").first();
    await expect(safeNameInput).toBeVisible();

    const originalName = await safeNameInput.inputValue();
    const testName = "Test Financial Team";

    // 1. Fill and save
    await safeNameInput.fill(testName);
    const saveBtn = page.getByRole("button", { name: "Save Changes" });
    await expect(saveBtn).not.toBeDisabled();
    await saveBtn.click();

    // 2. Assert success — the button briefly shows "Saved" then returns to "Save Changes"
    await expect(page.getByText("Settings saved successfully")).toBeVisible();
    await expect(safeNameInput).toHaveValue(testName);

    // 3. Wait for the "Saved" state to expire so the button returns to "Save Changes"
    await expect(saveBtn).toBeVisible({ timeout: 5000 });

    // 4. Revert: fill the original name and save again
    await safeNameInput.fill(originalName);
    await expect(saveBtn).not.toBeDisabled();
    await saveBtn.click();

    // 5. Confirm revert succeeded
    await expect(page.getByText("Settings saved successfully")).toBeVisible();
  });

  test("should toggle visibility of Resend API Key", async ({ page }) => {
    // Finds the Resend API Key input wrapper
    const resendInput = page.getByPlaceholder("re_...");
    await expect(resendInput).toBeVisible();
    await expect(resendInput).toHaveAttribute("type", "password");

    // Click Show
    await page.getByRole("button", { name: "Show" }).click();
    await expect(resendInput).toHaveAttribute("type", "text");

    // Click Hide
    await page.getByRole("button", { name: "Hide" }).click();
    await expect(resendInput).toHaveAttribute("type", "password");
  });
});
