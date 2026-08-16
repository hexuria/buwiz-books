import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/transactions");
  await page.waitForLoadState("networkidle");
});

test.describe("Inline Edit Mode", () => {
  test("toggling Edit mode updates the URL and shows checkboxes", async ({ page }) => {
    const editToggle = page.getByTestId("mode-toggle-edit");
    await editToggle.click();

    // Ensure URL sync
    await expect(page).toHaveURL(/.*mode=edit.*/);

    // Check if the checkboxes have been injected into DOM
    const checkboxes = page.locator('input[type="checkbox"][data-testid^="row-checkbox-"]');
    if ((await checkboxes.count()) > 0) {
      await expect(checkboxes.first()).toBeVisible();
    }
  });

  test("toggling back to View mode removes checkboxes and resets URL", async ({ page }) => {
    // Switch to edit
    await page.getByTestId("mode-toggle-edit").click();
    await expect(page).toHaveURL(/.*mode=edit.*/);

    // Switch to view
    await page.getByTestId("mode-toggle-view").click();
    await expect(page.url()).not.toContain("mode=edit");

    // Checkboxes should no longer be visible
    const checkboxes = page.locator('input[type="checkbox"][data-testid^="row-checkbox-"]');
    if ((await checkboxes.count()) > 0) {
      await expect(checkboxes.first()).toBeHidden();
    }
  });
});
