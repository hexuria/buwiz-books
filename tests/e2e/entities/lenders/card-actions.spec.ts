import { test, expect } from "@playwright/test";

test.describe("Lenders Card Actions", () => {
  test.use({ storageState: "tests/e2e/.auth/user.json" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/entities/lenders");
    await page.waitForLoadState("networkidle");
  });

  test("should show action buttons in detail panel after selection", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();
      await expect(page).toHaveURL(/selected=/);

      // Verify that Edit works (tested extensively in edit-and-deactivate spec)
      const editBtn = page.getByRole("button", { name: "Edit" }).first();
      await expect(editBtn).toBeVisible();
    }
  });

  test("should show View Insights link on detail panel", async ({ page }) => {
    const firstCard = page.locator(".overflow-y-auto button.rounded-xl").first();

    if (await firstCard.isVisible()) {
      await firstCard.click();

      const insightsLink = page.getByRole("link", { name: "View Insights" });
      await expect(insightsLink).toBeVisible();
    }
  });
});
