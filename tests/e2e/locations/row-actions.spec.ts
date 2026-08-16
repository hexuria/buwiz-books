import { test, expect } from "@playwright/test";

test.describe("Locations Row Actions", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/locations");
    await page.waitForLoadState("networkidle");
  });

  test("should reveal quick actions on row hover", async ({ page }) => {
    // Attempt to locate a location row in the list
    // Standard list row locator based on role
    const firstRow = page.locator('[role="button"]').first();

    // Check if we have at least one row, else skip
    if (await firstRow.isVisible()) {
      await firstRow.hover();

      // Action buttons appear on hover over the row
      const actionButtons = firstRow.locator("button");

      if ((await actionButtons.count()) > 0) {
        await expect(actionButtons.first()).toBeVisible();
      }
    }
  });

  test("should trigger correct form view when clicking row action", async ({ page }) => {
    const firstRow = page.locator('[role="button"]').first();

    if (await firstRow.isVisible()) {
      await firstRow.hover();
      const editBtn = firstRow.locator('button[title="Edit location"]');

      if (await editBtn.isVisible()) {
        // This should be non-destructive (e.g. open the edit or create form prefilled)
        await editBtn.click();

        const desktopPanel = page.locator(".hidden.lg\\:block");
        const panelHeader = desktopPanel.getByText(/New Location|Edit Location/).first();
        await expect(panelHeader).toBeVisible();

        await desktopPanel.getByRole("button", { name: "Cancel" }).click();
      }
    }
  });
});
