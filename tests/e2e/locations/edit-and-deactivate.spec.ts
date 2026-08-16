import { test, expect } from "@playwright/test";

test.describe("Locations Edit and Deactivate", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/locations");
    await page.waitForLoadState("networkidle");
  });

  test("should transition to edit mode from detail view", async ({ page }) => {
    const firstRow = page.locator('[role="button"]').first();

    if (await firstRow.isVisible()) {
      // Click row to enter detail view
      await firstRow.click();

      const desktopPanel = page.locator(".hidden.lg\\:block");
      const editBtn = desktopPanel.locator('button[title="Edit"]');
      if (await editBtn.isVisible()) {
        await editBtn.click();

        const saveBtn = page.getByRole("button", { name: "Save" });
        await expect(saveBtn).toBeVisible();

        // Cancel to exit safely
        await page.getByRole("button", { name: "Cancel" }).click();
      }
    }
  });

  test("should surface deactivation modal", async ({ page }) => {
    const firstRow = page.locator('[role="button"]').first();

    if (await firstRow.isVisible()) {
      await firstRow.click();

      const deactivateBtn = page.getByRole("button", { name: /Deactivate Location/i }).first();
      if (await deactivateBtn.isVisible()) {
        await deactivateBtn.click();

        // Look for confirmation modal by heading since it might not have role="dialog"
        const confirmHeading = page.getByRole("heading", { name: "Deactivate Location" });
        await expect(confirmHeading).toBeVisible();

        // Cancel to ensure no destructive actions happen
        const cancelModalBtn = page.getByRole("button", { name: "Cancel", exact: true });
        await cancelModalBtn.click();
      }
    }
  });
});
