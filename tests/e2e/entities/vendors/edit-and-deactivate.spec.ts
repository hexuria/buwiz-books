import { test, expect } from "@playwright/test";

test.describe("Vendors Edit and Deactivate", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/vendors");
    await page.waitForLoadState("networkidle");
  });

  test("should transition to edit mode from detail view", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();

      const editBtn = page.getByRole("button", { name: "Edit" }).first();
      if (await editBtn.isVisible()) {
        await editBtn.click();

        // In edit mode, confirm we see the correct header and Save Changes button
        const editHeader = page.getByText("Edit Vendor", { exact: true }).first();
        await expect(editHeader).toBeVisible();

        const saveBtn = page.getByRole("button", { name: "Save Changes" });
        await expect(saveBtn).toBeVisible();

        // Safe cancel
        const cancelBtn = page.getByRole("button", { name: "Cancel" });
        await cancelBtn.click();
      }
    }
  });

  test("should surface deactivation modal from detail view", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();

      // Deactivate button is normally in the detail pane
      const deactivateBtn = page.getByRole("button", { name: "Deactivate" }).first();

      if (await deactivateBtn.isVisible()) {
        await deactivateBtn.click();

        // Confirm dialog should be visible via standard role locator
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText("Deactivate Vendor")).toBeVisible();

        // Safe cancel out of the modal
        const modalCancelBtn = dialog.getByRole("button", { name: "Cancel" });
        await modalCancelBtn.click();

        await expect(dialog).not.toBeVisible();
      }
    }
  });
});
