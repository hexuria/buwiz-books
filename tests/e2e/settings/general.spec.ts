import { test, expect } from "@playwright/test";

test.describe("Settings General Tab", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const settingsLink = page.getByRole("link", { name: "Settings" });
    await expect(settingsLink).toHaveAttribute("href", /\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await settingsLink.click();
    await expect(page).toHaveURL(/\/organization\/[a-zA-Z0-9-]+\/settings$/);
    await page.getByRole("button", { name: "General", exact: true }).click();
  });

  test("should update organization name and revert it safely", async ({ page }) => {
    // Wait for the name input to be visible and grab its current value
    const nameInput = page.locator("input[type='text']").first();
    await expect(nameInput).toBeVisible();

    const originalName = await nameInput.inputValue();
    const testName = `${originalName} (Test Modified)`;

    try {
      // Modify the name
      await nameInput.fill(testName);

      // The save button should be enabled and display 'Save'
      const saveBtn = page.getByRole("button", { name: "Save", exact: true });
      await expect(saveBtn).not.toBeDisabled();
      await saveBtn.click();

      // UI should optimistically update to "Saved ✓"
      await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();

      // Ensure the value remains updated
      await expect(nameInput).toHaveValue(testName);
    } finally {
      // Revert the name to keep tests non-destructive
      await nameInput.fill(originalName);
      const revertBtn = page.getByRole("button", { name: "Save", exact: true });
      if (await revertBtn.isEnabled()) {
        await revertBtn.click();
        await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();
      }
    }
  });

  test("should verify URL Slug displays correctly", async ({ page }) => {
    // Assert the URL Slug container is present
    await expect(page.getByText("URL Slug")).toBeVisible();

    // There isn't an input for slug, just a div, we check for a value indicating it's rendered
    const slugContainer = page.locator("label:has-text('URL Slug') + div");
    await expect(slugContainer).toBeVisible();
    await expect(slugContainer).not.toBeEmpty();
  });
});
