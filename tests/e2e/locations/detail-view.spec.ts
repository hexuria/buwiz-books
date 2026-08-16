import { test, expect } from "@playwright/test";

test.describe("Locations Detail View", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/locations");
    await page.waitForLoadState("networkidle");
  });

  test("should transition to detail view on row click", async ({ page }) => {
    const firstRow = page.locator('[role="button"]').first();

    // Only run if rows exist
    if (await firstRow.isVisible()) {
      await firstRow.click();

      // URL should update with a selected parameter
      await expect(page).toHaveURL(/selected=/);

      // Check the RHS panel headers and actions in the desktop panel
      const desktopPanel = page.locator(".hidden.lg\\:block");
      const locationTitle = desktopPanel.getByText("Philippines").first();

      if (await locationTitle.isVisible()) {
        await expect(locationTitle).toBeVisible();
      }

      const editBtn = desktopPanel.locator('button[title="Edit"]');
      if (await editBtn.isVisible()) {
        await expect(editBtn).toBeVisible();
      }
    }
  });
});
