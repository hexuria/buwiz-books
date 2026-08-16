import { test, expect } from "@playwright/test";

test.describe("Departments Edit and Deactivate", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/departments");
    await page.waitForLoadState("networkidle");
  });

  test("should transition to edit mode from detail view", async ({ page }) => {
    const firstRow = page.locator("tbody tr").first();

    if (await firstRow.isVisible()) {
      // Click row to enter detail view
      await firstRow.click();

      const editBtn = page.getByRole("button", { name: /Edit/i }).first();
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
    const firstRow = page.locator("tbody tr").first();

    if (await firstRow.isVisible()) {
      await firstRow.click();

      const editBtn = page.getByRole("button", { name: /Edit/i }).first();
      if (await editBtn.isVisible()) {
        await editBtn.click();

        const deactivateBtn = page.getByRole("button", { name: /Deactivate/i });
        if (await deactivateBtn.isVisible()) {
          await deactivateBtn.click();

          // Look for confirmation modal
          const confirmDialog = page.getByRole("dialog");
          await expect(confirmDialog).toBeVisible();

          // Cancel to ensure no destructive actions happen
          const cancelModalBtn = confirmDialog.getByRole("button", { name: /Cancel|No/i }).first();
          await cancelModalBtn.click();
        }
      }
    }
  });
});
