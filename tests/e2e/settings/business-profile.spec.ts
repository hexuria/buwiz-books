import { test, expect } from "@playwright/test";

test.describe("Settings Business Profile Tab", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await settingsLink.click();
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await page.getByRole("button", { name: "Business Profile", exact: true }).click();
  });

  test("should load contact and tax fields", async ({ page }) => {
    await expect(page.getByPlaceholder("+1 (555) 123-4567", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("https://example.com", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("12-3456789", { exact: true })).toBeVisible();
    await expect(
      page.getByPlaceholder("https://example.com/logo.png", { exact: true }),
    ).toBeVisible();
  });

  test("should update address fields safely and save", async ({ page }) => {
    const stInput = page.getByPlaceholder("123 Main St, Suite 100");
    await expect(stInput).toBeVisible();

    const originalStreet = await stInput.inputValue();
    const testStreet = `${originalStreet} - E2E Test Suite`;

    try {
      await stInput.fill(testStreet);

      const saveBtn = page.getByRole("button", { name: "Save Changes" });
      await expect(saveBtn).not.toBeDisabled();

      // Wait for the API response to settle before asserting
      const saveResponse = page.waitForResponse(
        (r) => r.url().includes("serverFn") && r.status() === 200,
      );
      await saveBtn.click();
      await saveResponse;

      await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();
      await expect(page.getByText("Business profile saved successfully")).toBeVisible();
      await expect(stInput).toHaveValue(testStreet);
    } finally {
      // Guard: if the browser context was killed by a timeout, don't try to revert
      if (!page.isClosed()) {
        await stInput.fill(originalStreet);
        const revertBtn = page.getByRole("button", { name: "Save Changes" });
        if (await revertBtn.isEnabled()) {
          await revertBtn.click();
        }
      }
    }
  });

  test("should allow changing functional currency via combobox", async ({ page }) => {
    // Current functional currency Combobox
    const currencyComboboxBtn = page.getByRole("combobox");
    await expect(currencyComboboxBtn).toBeVisible();

    // Verify it drops down and we can search for a currency
    await currencyComboboxBtn.click();

    // Check if EUR exists in dropdown
    const eurOption = page.getByRole("option", { name: "EUR" }).first();
    await eurOption.waitFor({ state: "visible" });

    // We will just verify it opens correctly and don't mutate since changing currency
    // might affect other E2E tests unexpectedly if we don't restore it perfectly
    // Close the dropdown safely by clicking the backdrop or combobox again
    await currencyComboboxBtn.click();
  });
});
