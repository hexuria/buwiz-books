import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/transactions");
  await page.waitForLoadState("networkidle");
});

test.describe("Batch Actions functionality", () => {
  test("checking a row in edit mode brings up the Batch Action bar", async ({ page }) => {
    await page.getByTestId("mode-toggle-edit").click();

    // Select the first input checkbox
    const firstCheckbox = page
      .locator('input[type="checkbox"][data-testid^="row-checkbox-"]')
      .first();

    if (await firstCheckbox.isVisible()) {
      await firstCheckbox.check();

      // Batch bar slides up
      const batchBar = page.getByTestId("batch-bar");
      await expect(batchBar).toBeVisible();

      // Counter must reflect selection
      await expect(page.getByTestId("batch-count")).toContainText("1 selected");
    }
  });

  test("multiple selections update batch counter and verify options", async ({ page }) => {
    await page.getByTestId("mode-toggle-edit").click();

    const checkboxes = page.locator('input[type="checkbox"][data-testid^="row-checkbox-"]');

    if ((await checkboxes.count()) >= 2) {
      await checkboxes.nth(0).check();
      await checkboxes.nth(1).check();

      const batchBar = page.getByTestId("batch-bar");
      await expect(batchBar).toBeVisible();

      await expect(page.getByTestId("batch-count")).toContainText("2 selected");

      // Ensure 'Move To' and 'Delete' are present
      await expect(page.getByTestId("batch-move-to")).toBeVisible();
      await expect(page.getByTestId("batch-delete")).toBeVisible();
    }
  });

  test("unchecking all rows automatically dismisses the batch bar", async ({ page }) => {
    await page.getByTestId("mode-toggle-edit").click();

    const firstCheckbox = page
      .locator('input[type="checkbox"][data-testid^="row-checkbox-"]')
      .first();

    if (await firstCheckbox.isVisible()) {
      await firstCheckbox.check();
      await expect(page.getByTestId("batch-bar")).toBeVisible();

      await firstCheckbox.uncheck();
      await expect(page.getByTestId("batch-bar")).toBeHidden();
    }
  });
});
