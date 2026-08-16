import { test, expect } from "@playwright/test";

test.describe("Import Categories Modal", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
  });

  test("can open and interact with import categories flow", async ({ page }) => {
    // Click the dropdown toggle next to "New Category"
    // The caret button is the next sibling logic. There's only one chevron beside "New Category"
    await page
      .locator("button:has(svg)")
      .filter({ hasText: /^$/ })
      .filter({ has: page.locator('svg path[d*="M6 9l6 6 6-6"]') })
      .first()
      .click();

    // Click Import Categories from dropdown
    await page.getByText("Import Categories…").click();

    // Verify modal appears
    await expect(page.getByText("Import Categories", { exact: true })).toBeVisible();

    // Verify Browse Files label
    await expect(page.getByText("Browse Files")).toBeVisible();

    // Verify the template anchor button
    await expect(page.getByText("here", { exact: true })).toBeVisible();

    // In a headless environment, simulating the file drop and parsing can be complex,
    // so we primary test the UI state of the modal and cancellation.
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    // Verify modal is dismissed
    await expect(page.getByText("Browse Files")).toBeHidden();
  });
});
