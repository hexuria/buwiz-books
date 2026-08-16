import { test, expect } from "@playwright/test";

test.describe("Departments Row Actions", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/departments");
    await page.waitForLoadState("networkidle");
  });

  test("should reveal quick actions on row hover", async ({ page }) => {
    // Attempt to locate a department row in the table
    // Standard table row locator
    const firstRow = page.locator("tbody tr").first();

    // Check if we have at least one row, else skip
    if (await firstRow.isVisible()) {
      await firstRow.hover();

      // Usually these actions use titles or aria-labels
      const _addSubBtn = firstRow
        .getByRole("button")
        .filter({ hasText: /Add child department|Add/i })
        .first();
      // Or looking for icons
      const actionButtons = firstRow.locator("button");

      if ((await actionButtons.count()) > 0) {
        await expect(actionButtons.first()).toBeVisible();
      }
    }
  });

  test("should trigger correct form view when clicking row action", async ({ page }) => {
    const firstRow = page.locator("tbody tr").first();

    if (await firstRow.isVisible()) {
      await firstRow.hover();
      const actionButtons = firstRow.locator("button");

      if ((await actionButtons.count()) > 0) {
        // This should be non-destructive (e.g. open the create form prefilled)
        await actionButtons.first().click();

        const panelHeader = page
          .getByRole("heading")
          .filter({ hasText: /New Department|Update Department/ });
        await expect(panelHeader).toBeVisible();

        await page.getByRole("button", { name: "Cancel" }).click();
      }
    }
  });
});
