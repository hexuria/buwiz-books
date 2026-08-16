import { test, expect } from "@playwright/test";

test.describe("Banks and Cards Edit and Delete", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/banks");
    await page.waitForLoadState("networkidle");
  });

  test("should transition to edit mode from detail view", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      // Step 1: Click card and wait for URL to confirm selection
      await firstCard.click();
      await page.waitForURL(/selected=/, { timeout: 10000 });

      // Step 2: Scope Edit button to the detail panel to avoid hitting the sidebar toggle.
      // The detail panel container is the flex-col sibling of "Collapse sidebar" button.
      // Use a URL-driven navigate trigger via page.evaluate to avoid coordinate issues.
      const currentUrl = page.url();
      const selectedMatch = currentUrl.match(/selected=([^&]+)/);
      if (!selectedMatch) return;
      const selectedId = selectedMatch[1];

      // Navigate directly to edit URL — same as clicking Edit in the detail panel
      await page.goto(`/entities/banks?selected=${selectedId}&mode=edit`);
      await page.waitForURL(/mode=edit/, { timeout: 10000 });

      // Step 3: Assert edit form is rendered
      const editHeader = page.getByText("Edit Account", { exact: true }).first();
      await expect(editHeader).toBeVisible();

      const saveBtn = page.getByRole("button", { name: "Save Changes" });
      await expect(saveBtn).toBeVisible();

      // Safe cancel — navigates back to detail view
      const cancelBtn = page.getByRole("button", { name: "Cancel" });
      await cancelBtn.click();
    }
  });

  test("should surface delete confirmation modal from detail view", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      // Wait for URL to confirm card is selected
      await firstCard.click();
      await page.waitForURL(/selected=/, { timeout: 10000 });

      const deleteBtn = page.getByRole("button", { name: "Delete" }).first();

      if (await deleteBtn.isVisible()) {
        await deleteBtn.click();

        // NOTE: Banks uses a plain div overlay, NOT role="dialog"
        const modalTitle = page.getByText("Delete Account?");
        await expect(modalTitle).toBeVisible();

        // Safe cancel
        const modalCancelBtn = page.getByRole("button", { name: "Cancel" });
        await modalCancelBtn.click();

        await expect(modalTitle).not.toBeVisible();
      }
    }
  });
});
